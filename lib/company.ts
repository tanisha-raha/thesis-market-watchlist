import "server-only";
import { unstable_cache } from "next/cache";
import { and, asc, desc, eq, gt, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { priceBars, quoteObservations, quotes, symbolStats, symbols, watchlistItems } from "@/db/schema";
import { liveProvider } from "@/lib/market/live";
import { bounded } from "@/lib/market-brief";
import { classify, type FeedHealth } from "@/lib/feed-health";
import { describeSecurity, type Security } from "@/lib/securities";
import type { HistoryPoint } from "@/lib/presentation";
import type { IntradayPoint } from "@/lib/chart-ranges";
import type { Bar } from "@/lib/market/types";

/**
 * Company lookup — the read behind the symbol page.
 *
 * A user must be able to LOOK at a company before deciding to watch it. Search is
 * discovery, not an add-shortcut, so this resolves any security the provider
 * supports, whether or not it is on the user's watchlist, and says honestly which
 * parts of the picture exist.
 *
 * TWO DATA PATHS, NEVER MIXED SILENTLY:
 *
 *   TRACKED — the symbol is in `symbols`, so we read the committed quote, the
 *   stored bars, the observed intraday path and the computed statistics. Nothing
 *   here touches the network.
 *
 *   LOOKUP — nobody watches it yet and we hold nothing. One cached, bounded,
 *   READ-ONLY request per symbol fetches a quote and daily bars. Nothing is
 *   persisted: this is an interactive lookup, not the cold historical backfill
 *   the deployed app is forbidden from doing. A provider failure returns an empty
 *   history and the page says so.
 */

/** Provider symbols are tickers, optionally with an exchange suffix. */
const SYMBOL_SHAPE = /^[A-Z0-9][A-Z0-9.&^-]{0,19}$/;

export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL_SHAPE.test(symbol) ? symbol : null;
}

/**
 * A cached value crosses a JSON boundary, so `asOf` comes back as a STRING on
 * every cache hit. Storing the instant as an ISO string and rebuilding the Date
 * on the way out keeps the first request and the cached one identical — the
 * alternative is a page that renders correctly once and then throws on
 * "Invalid time value" two minutes later.
 */
type CachedQuote = { symbol: string; price: number; previousClose: number | null; asOf: string; marketState: string | null; currency: string | null; name: string | null; exchange: string | null; timeZone: string | null };

const lookupQuote = unstable_cache(async (symbol: string): Promise<CachedQuote | null> => {
  try {
    const { quotes: found } = await bounded(liveProvider.getQuotes([symbol]));
    const quote = found[0];
    return quote ? { ...quote, asOf: quote.asOf.toISOString() } : null;
  } catch { return null; }
}, ["company-lookup-quote-v1"], { revalidate: 120 });

/** Rebuilds the instant, and refuses a quote whose timestamp is not usable. */
function hydrate(quote: CachedQuote | null) {
  if (!quote) return null;
  const asOf = new Date(quote.asOf);
  return Number.isFinite(asOf.getTime()) ? { ...quote, asOf } : null;
}

const lookupHistory = unstable_cache(async (symbol: string): Promise<Bar[]> => {
  try { return await bounded(liveProvider.getDailyBars(symbol, 400)); }
  catch { return []; }
}, ["company-lookup-history-v1"], { revalidate: 900 });

export type CompanyQuote = {
  price: number | null;
  previousClose: number | null;
  changePercent: number | null;
  asOf: Date | null;
  marketState: string | null;
};

/** The last session we hold a bar for. Fields the source did not give stay null. */
export type SessionBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
};

export type CompanyStats = {
  realizedVol20: number | null;
  medianVolume20: number | null;
  ma20: number | null;
  beta60: number | null;
  high52w: number | null;
  low52w: number | null;
  high20: number | null;
  low20: number | null;
  sessionsUsed: number;
  computedAt: Date;
};

export type CompanyView = {
  symbol: string;
  name: string | null;
  security: Security;
  /** True when this user watches it — the only thing that unlocks thesis surfaces. */
  watched: boolean;
  watchlistItemId: number | null;
  quote: CompanyQuote;
  /** Where the quote came from. A lookup quote is live but never persisted. */
  quoteSource: "stored" | "lookup" | "none";
  health: FeedHealth;
  daily: HistoryPoint[];
  historySource: "stored" | "lookup" | "none";
  intraday: IntradayPoint[];
  latestBar: SessionBar | null;
  stats: CompanyStats | null;
};

const num = (value: string | number | null | undefined) =>
  value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;

/** Downsampled server-side: the browser never needs every 5-minute observation. */
const INTRADAY_DAYS = 7;
const INTRADAY_LIMIT = 1500;
const DAILY_SESSIONS = 260;

export async function getCompanyView(userId: number, rawSymbol: string): Promise<CompanyView | null> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return null;

  const [[tracked], [item], [storedQuote], [statsRow]] = await Promise.all([
    db.select().from(symbols).where(eq(symbols.symbol, symbol)).limit(1),
    db.select({ id: watchlistItems.id }).from(watchlistItems)
      .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol))).limit(1),
    db.select().from(quotes).where(eq(quotes.symbol, symbol)).limit(1),
    db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1),
  ]);

  // Never seen before: one bounded lookup decides whether this is a real security
  // at all. An unresolvable ticker is a 404, not an empty page pretending to be one.
  const lookup = tracked ? null : hydrate(await lookupQuote(symbol));
  if (!tracked && !lookup) return null;

  const security = describeSecurity({
    symbol,
    name: tracked?.name ?? lookup?.name ?? null,
    exchange: tracked?.exchange ?? lookup?.exchange ?? null,
    currency: tracked?.currency ?? lookup?.currency ?? null,
    timeZone: tracked?.exchangeTimezone ?? lookup?.timeZone ?? null,
  });

  const close = sql<string>`coalesce(${priceBars.currentProviderAdjClose}, ${priceBars.currentProviderClose})`;
  const [storedBars, observations] = await Promise.all([
    tracked
      ? db.select({
          date: priceBars.tradingDate, close,
          open: priceBars.currentProviderOpen, raw: priceBars.currentProviderClose,
          volume: priceBars.currentProviderVolume,
        }).from(priceBars)
        .where(and(eq(priceBars.symbol, symbol), isNotNull(close), gt(close, "0"), gt(priceBars.currentProviderVolume, "0")))
        .orderBy(desc(priceBars.tradingDate)).limit(DAILY_SESSIONS)
      : Promise.resolve([]),
    tracked
      ? db.select({ at: quoteObservations.asOf, price: quoteObservations.price })
        .from(quoteObservations)
        .where(and(eq(quoteObservations.symbol, symbol), gte(quoteObservations.asOf, new Date(Date.now() - INTRADAY_DAYS * 864e5))))
        .orderBy(asc(quoteObservations.asOf)).limit(INTRADAY_LIMIT)
      : Promise.resolve([]),
  ]);

  const stored = storedBars.reverse();
  const daily: HistoryPoint[] = stored.flatMap((bar) => {
    const value = num(bar.close);
    return value == null ? [] : [{ date: bar.date, close: value }];
  });

  // Stored history first; the provider only when we hold none at all.
  const providerBars = daily.length >= 2 ? [] : await lookupHistory(symbol);
  const lookupDaily: HistoryPoint[] = providerBars.flatMap((bar) => {
    const value = bar.adjClose ?? bar.close;
    return value != null && Number.isFinite(value) && value > 0 && bar.volume != null && bar.volume > 0
      ? [{ date: bar.date, close: value }]
      : [];
  });

  const usingStored = daily.length >= 2;
  const history = usingStored ? daily : lookupDaily;

  const lastStored = stored.at(-1);
  const lastProvider = providerBars.at(-1);
  const latestBar: SessionBar | null = usingStored && lastStored
    // Stored bars carry no high or low — the schema never claimed them — so those
    // stay null and the panel omits them rather than inventing a day's range.
    ? { date: lastStored.date, open: num(lastStored.open), high: null, low: null, close: num(lastStored.raw), volume: num(lastStored.volume) }
    : lastProvider
      ? { date: lastProvider.date, open: lastProvider.open, high: lastProvider.high, low: lastProvider.low, close: lastProvider.close, volume: lastProvider.volume }
      : null;

  const price = storedQuote ? num(storedQuote.price) : lookup?.price ?? null;
  const previousClose = storedQuote ? num(storedQuote.previousClose) : lookup?.previousClose ?? null;

  return {
    symbol,
    name: security.name,
    security,
    watched: item != null,
    watchlistItemId: item?.id ?? null,
    quote: {
      price,
      previousClose,
      changePercent: price != null && previousClose != null && previousClose !== 0
        ? ((price - previousClose) / previousClose) * 100
        : null,
      asOf: storedQuote?.asOf ?? lookup?.asOf ?? null,
      marketState: storedQuote?.marketState ?? lookup?.marketState ?? null,
    },
    quoteSource: storedQuote ? "stored" : lookup ? "lookup" : "none",
    health: classify(tracked?.consecutiveFeedMisses ?? 0),
    daily: history,
    historySource: usingStored ? "stored" : lookupDaily.length >= 2 ? "lookup" : "none",
    intraday: observations.map((row) => ({ at: row.at.toISOString(), price: Number(row.price) }))
      .filter((point) => Number.isFinite(point.price) && point.price > 0),
    latestBar,
    stats: statsRow
      ? {
          realizedVol20: num(statsRow.realizedVol20), medianVolume20: num(statsRow.medianVolume20),
          ma20: num(statsRow.ma20), beta60: num(statsRow.beta60),
          high52w: num(statsRow.high52w), low52w: num(statsRow.low52w),
          high20: num(statsRow.high20), low20: num(statsRow.low20),
          sessionsUsed: statsRow.sessionsUsed, computedAt: statsRow.computedAt,
        }
      : null,
  };
}
