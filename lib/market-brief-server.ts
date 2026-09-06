import "server-only";
import { unstable_cache } from "next/cache";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { priceBars, quotes } from "@/db/schema";
import { liveProvider } from "@/lib/market/live";
import { MARKET_INDICES, REGION_PRIMARY_INDEX, bounded, indexValue, marketStatusFrom, type MarketStatus } from "@/lib/market-brief";
import { fetchMarketNews } from "@/lib/market-news";
import { REGIONS, REGION_ORDER, type MarketRegion } from "@/lib/securities";
import type { HistoryPoint } from "@/lib/presentation";
import type { Quote } from "@/lib/market/types";
import { traced } from "@/lib/trace";

/**
 * How long an interactive page will wait on the provider before giving up.
 *
 * Deliberately shorter than the ingestion path's budget. This request is between
 * a person and a screen, and the product already has a better answer than a
 * spinner: the last committed quote, rendered with its own freshness label. Yahoo
 * has been measured at over 2.8s cold from a residential connection and throttles
 * datacenter IPs harder, so waiting the full budget would mean showing nothing
 * while a perfectly good stored value sat in the database.
 */
const INTERACTIVE_TIMEOUT_MS = 3000;

// Public context only: never cache a user's digest, identity, or watchlist.
const fetchIndices = unstable_cache(async () => {
  try { return (await bounded(liveProvider.getQuotes(MARKET_INDICES.map((i) => i.symbol)), INTERACTIVE_TIMEOUT_MS)).quotes; }
  catch { return [] as Quote[]; }
}, ["market-brief-indices-v2"], { revalidate: 120 });

export const getMarketNews = unstable_cache(fetchMarketNews, ["market-brief-news-et-v1"], { revalidate: 600 });

/**
 * Recent daily closes for one index, for the card sparkline.
 *
 * Stored bars are the first source and the only one we ever write. Indices
 * outside the seeded Indian set have no stored history at all, so rather than
 * leaving six cards with an unexplained empty rectangle we make one cached,
 * bounded, READ-ONLY chart request per index. Nothing is persisted — this is
 * not the cold historical backfill the brief rules out — and a failure returns
 * an empty series, which the card renders as "History unavailable".
 */
const fetchIndexHistory = unstable_cache(async (symbol: string): Promise<HistoryPoint[]> => {
  try {
    const bars = await bounded(liveProvider.getDailyBars(symbol, 30), INTERACTIVE_TIMEOUT_MS);
    return bars.flatMap((b) => b.close != null && Number.isFinite(b.close) && b.close > 0 ? [{ date: b.date, close: b.close }] : []).slice(-20);
  } catch { return []; }
}, ["market-brief-index-history-v1"], { revalidate: 900 });

export type MarketIndexCard = {
  symbol: string;
  name: string;
  region: MarketRegion;
  timeZone: string;
  quote: ReturnType<typeof indexValue>;
  /** True when the live fetch failed and we are rendering the last stored quote. */
  degraded: boolean;
  points: HistoryPoint[];
};

export type MarketOverview = {
  regions: { region: MarketRegion; label: string; status: MarketStatus; indices: MarketIndexCard[] }[];
};

/** Quote-only request with stored fallback; no ingestion and no history writes. */
export async function getMarketOverview(): Promise<MarketOverview> {
  const [live, stored] = await Promise.all([
    traced("overview:providerQuotes", () => fetchIndices()),
    traced("overview:storedQuotes", () => db.select().from(quotes).where(inArray(quotes.symbol, MARKET_INDICES.map((i) => i.symbol)))),
  ]);

  const cards = await Promise.all(MARKET_INDICES.map(async (index): Promise<MarketIndexCard> => {
    const region = REGIONS[index.region];
    const cached = stored.find((q) => q.symbol === index.symbol);
    const fresh = indexValue(live.find((q) => q.symbol === index.symbol));
    const fallback = cached
      ? indexValue({
          symbol: cached.symbol, price: Number(cached.price),
          previousClose: cached.previousClose == null ? null : Number(cached.previousClose),
          asOf: cached.asOf, marketState: cached.marketState, name: index.name,
          currency: null, exchange: null, timeZone: region.timeZone,
        })
      : null;
    const quote = fresh && (!fallback || fresh.asOf >= fallback.asOf) ? fresh : fallback;

    const bars = await traced(`overview:storedBars:${index.symbol}`, () => db
      .select({ date: priceBars.tradingDate, close: priceBars.currentProviderClose })
      .from(priceBars).where(eq(priceBars.symbol, index.symbol))
      .orderBy(desc(priceBars.tradingDate)).limit(20));
    // Index volume is not meaningful; null/non-positive closes remain excluded.
    const storedPoints = bars.reverse().flatMap((b) =>
      b.close != null && Number.isFinite(Number(b.close)) && Number(b.close) > 0 ? [{ date: b.date, close: Number(b.close) }] : []);
    const points = storedPoints.length >= 2 ? storedPoints : await traced(`overview:providerHistory:${index.symbol}`, () => fetchIndexHistory(index.symbol));

    return {
      symbol: index.symbol,
      name: index.name,
      region: index.region,
      // The provider's own zone when it gave us one, the market's otherwise. A
      // US index never renders on an IST clock either way.
      timeZone: quote?.timeZone ?? region.timeZone,
      quote,
      degraded: !fresh,
      points,
    };
  }));

  return {
    regions: REGION_ORDER.map((region) => {
      const indices = cards.filter((card) => card.region === region);
      const primary = indices.find((card) => card.symbol === REGION_PRIMARY_INDEX[region]) ?? indices[0];
      return {
        region,
        label: REGIONS[region].label,
        // Each market answers for itself, from its own index's reported state.
        // No state reported means no claim: the cards show freshness instead.
        status: marketStatusFrom(primary?.degraded ? null : primary?.quote?.marketState),
        indices,
      };
    }),
  };
}
