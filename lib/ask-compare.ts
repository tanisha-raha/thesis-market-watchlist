import "server-only";
import { and, desc, eq, inArray, isNotNull, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, priceBars, quotes, symbolStats, symbols, theses, watchlistItems } from "@/db/schema";
import { evidenceFrom, type EvidenceEntry } from "@/lib/digest";
import { getLatestAnomaly, type StoredAnomaly } from "@/lib/ml/anomaly-server";
import { describeSecurity, formatCount, formatMoney, marketLine, type Security } from "@/lib/securities";
import { indexDisplayName } from "@/lib/market-brief";
import { classify, type FeedHealth } from "@/lib/feed-health";
import { formatExchangeTime } from "@/lib/time";
import { thesisLabel } from "@/lib/thesis-display";

/**
 * Companies set side by side, from what THESIS has already recorded.
 *
 * WHY THIS EXISTS. Declining to recommend a stock is only half an answer. The
 * useful other half is "here is what I actually observed about the two you are
 * weighing", and a user who has just been told no will name those two companies
 * in their next message. That turn needs real evidence, so this reads it.
 *
 * WHAT IT WILL NOT DO. It never ranks, scores, or concludes. It never fetches:
 * every figure comes from a committed row, and a company THESIS holds nothing
 * for is said to be empty rather than filled in from the provider. Personal
 * surfaces — the saved condition, its note, its deterministic state — appear
 * only for companies this user actually watches; market evidence is the same
 * market evidence any authenticated user can open a company page and read.
 */

export type ComparisonRow = {
  symbol: string;
  name: string | null;
  security: Security;
  /** Personal surfaces are unlocked by this and nothing else. */
  watched: boolean;
  health: FeedHealth;
  price: number | null;
  changePercent: number | null;
  asOf: Date | null;
  marketState: string | null;
  /** Stored adjusted closes only. Null when fewer than the full window is held. */
  return20d: number | null;
  realizedVol20: number | null;
  beta60: number | null;
  benchmark: string | null;
  medianVolume20: number | null;
  sessionsUsed: number | null;
  anomaly: StoredAnomaly | null;
  latestEvent: { signalType: string; occurredAt: Date; resolvedAt: Date | null; evidence: EvidenceEntry[] } | null;
  thesis: { type: string; state: string; note: string | null } | null;
};

const num = (value: string | number | null | undefined) =>
  value == null ? null : Number.isFinite(Number(value)) ? Number(value) : null;

const RETURN_SESSIONS = 20;

/** One security's stored picture. Reads only; nothing here writes or fetches. */
async function loadRow(userId: number, symbol: string): Promise<ComparisonRow | null> {
  const close = sql<string>`coalesce(${priceBars.currentProviderAdjClose}, ${priceBars.currentProviderClose})`;
  const [[meta], [quote], [stats], bars, [event], anomaly, [owned]] = await Promise.all([
    db.select().from(symbols).where(eq(symbols.symbol, symbol)).limit(1),
    db.select().from(quotes).where(eq(quotes.symbol, symbol)).limit(1),
    db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1),
    db.select({ date: priceBars.tradingDate, close }).from(priceBars)
      .where(and(eq(priceBars.symbol, symbol), isNotNull(close), gt(close, "0"), gt(priceBars.currentProviderVolume, "0")))
      .orderBy(desc(priceBars.tradingDate)).limit(RETURN_SESSIONS + 1),
    db.select().from(changeEvents).where(eq(changeEvents.symbol, symbol)).orderBy(desc(changeEvents.occurredAt)).limit(1),
    getLatestAnomaly(symbol).catch(() => null),
    db.select({ id: watchlistItems.id, type: theses.type, state: theses.state, note: theses.note })
      .from(watchlistItems).leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
      .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol))).limit(1),
  ]);
  if (!meta) return null;

  const security = describeSecurity({ symbol, name: meta.name, exchange: meta.exchange, currency: meta.currency, timeZone: meta.exchangeTimezone });
  const price = num(quote?.price);
  const previousClose = num(quote?.previousClose);
  // Oldest first, so the window runs from the earliest stored close to the latest.
  const series = bars.map((bar) => num(bar.close)).filter((value): value is number => value != null).reverse();
  const return20d = series.length > RETURN_SESSIONS && series[0] > 0
    ? (series[series.length - 1] / series[0] - 1) * 100
    : null;

  return {
    symbol,
    name: security.name,
    security,
    watched: owned != null,
    health: classify(meta.consecutiveFeedMisses ?? 0),
    price,
    changePercent: price != null && previousClose != null && previousClose !== 0 ? ((price - previousClose) / previousClose) * 100 : null,
    asOf: quote?.asOf ?? null,
    marketState: quote?.marketState ?? null,
    return20d,
    realizedVol20: num(stats?.realizedVol20),
    beta60: num(stats?.beta60),
    benchmark: security.benchmark,
    medianVolume20: num(stats?.medianVolume20),
    sessionsUsed: stats?.sessionsUsed ?? null,
    anomaly,
    latestEvent: event
      ? { signalType: event.signalType, occurredAt: event.occurredAt, resolvedAt: event.resolvedAt, evidence: evidenceFrom(event.explainJson as Record<string, unknown>, security.currency) }
      : null,
    // Watchlist membership is the only thing that unlocks a personal surface.
    thesis: owned?.type ? { type: owned.type, state: owned.state ?? "WATCHING", note: owned.note } : null,
  };
}

export async function getComparison(userId: number, symbolList: string[]): Promise<ComparisonRow[]> {
  const unique = [...new Set(symbolList)].slice(0, 4);
  if (unique.length === 0) return [];
  const rows = await Promise.all(unique.map((symbol) => loadRow(userId, symbol)));
  return rows.filter((row): row is ComparisonRow => row != null);
}

/** Companies named but not held at all, so the answer can say so by name. */
export async function unknownSecurities(symbolList: string[]): Promise<string[]> {
  if (symbolList.length === 0) return [];
  const known = await db.select({ symbol: symbols.symbol }).from(symbols).where(inArray(symbols.symbol, symbolList));
  const held = new Set(known.map((row) => row.symbol));
  return symbolList.filter((symbol) => !held.has(symbol));
}

/* ------------------------------------------------------------ presentation */

const pct = (value: number | null, digits = 2) => value == null ? null : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

/** One line per recorded measurement, and silence where nothing was recorded. */
export function lines(row: ComparisonRow): string[] {
  const money = (value: number | null) => value == null ? null : formatMoney(value, row.security.currency);
  const out: string[] = [];
  if (row.price != null) {
    const move = pct(row.changePercent);
    out.push(`last stored price ${money(row.price)}${move ? ` (${move} against the previous close)` : ""}${row.asOf ? `, as of ${formatExchangeTime(row.asOf, row.security.timeZone)}` : ""}${row.health === "degraded" ? " — feed degraded, this is the last known good value" : ""}`);
  } else {
    out.push("no stored quote yet");
  }
  if (row.return20d != null) out.push(`${pct(row.return20d)} over the last ${RETURN_SESSIONS} stored sessions`);
  if (row.realizedVol20 != null) out.push(`20-day realized volatility ${(row.realizedVol20 * 100).toFixed(2)}% daily`);
  if (row.beta60 != null) out.push(`beta ${row.beta60.toFixed(2)} over 60 sessions against ${row.benchmark ? indexDisplayName(row.benchmark) : "its benchmark"}`);
  else if (row.benchmark) out.push(`no beta against ${indexDisplayName(row.benchmark)} stored yet`);
  if (row.medianVolume20 != null) out.push(`median volume ${formatCount(row.medianVolume20, row.security.currency)} over 20 sessions`);
  if (row.anomaly) {
    out.push(row.anomaly.status === "UNUSUAL"
      ? `the anomaly layer classified the ${row.anomaly.tradingDate} session as unusual for this company`
      : `the anomaly layer found the ${row.anomaly.tradingDate} session typical for this company`);
  }
  if (row.latestEvent) {
    out.push(`last detected event: ${row.latestEvent.signalType.replace(/_/g, " ")} at ${formatExchangeTime(row.latestEvent.occurredAt, row.security.timeZone)}${row.latestEvent.resolvedAt ? ", since reversed" : ", still open"}`);
  }
  if (row.thesis) {
    out.push(`you watch it, with “${thesisLabel(row.thesis.type)}” recorded and a deterministic state of ${row.thesis.state.toLowerCase().replace(/_/g, " ")}`);
  }
  if (out.length === 1 && row.price == null) out.push("and no statistics, events or anomaly evaluation either");
  return out;
}

const METRIC_FIELD = {
  volatility: { label: "20-day realized volatility", get: (r: ComparisonRow) => r.realizedVol20, show: (v: number) => `${(v * 100).toFixed(2)}% daily`, higher: "more volatile" },
  movement: { label: `return over the last ${RETURN_SESSIONS} stored sessions`, get: (r: ComparisonRow) => r.return20d, show: (v: number) => pct(v)!, higher: "risen more" },
  benchmark: { label: "60-day beta", get: (r: ComparisonRow) => r.beta60, show: (v: number) => v.toFixed(2), higher: "moved more with its market" },
  volume: { label: "20-session median volume", get: (r: ComparisonRow) => r.medianVolume20, show: (v: number) => v.toLocaleString("en-US"), higher: "traded more heavily" },
} as const;

export type ComparisonMetricKey = keyof typeof METRIC_FIELD;

/**
 * A direct answer to "which one is more X", when X is something THESIS stores.
 *
 * Only ever a comparison of two recorded numbers, and only when both exist.
 * Volatility is not risk and beta is not quality: the sentence says which figure
 * is larger and stops there.
 */
function metricAnswer(rows: ComparisonRow[], metric: ComparisonMetricKey | null, unknown: string[]): string | null {
  if (!metric || !(metric in METRIC_FIELD)) return null;
  if (rows.length < 2) {
    return unknown.length
      ? `I can’t compare ${METRIC_FIELD[metric].label} across them: THESIS holds no recorded data at all for ${unknown.join(" or ")}.`
      : null;
  }
  const field = METRIC_FIELD[metric];
  const values = rows.map((row) => ({ row, value: field.get(row) }));
  const have = values.filter((entry): entry is { row: ComparisonRow; value: number } => entry.value != null);
  if (have.length < 2) {
    const missing = values.filter((entry) => entry.value == null).map((entry) => entry.row.symbol);
    return `THESIS has no stored ${field.label} for ${missing.join(" or ")}, so I can’t compare that measurement across them.`;
  }
  const sorted = [...have].sort((a, b) => b.value - a.value);
  const [top, ...rest] = sorted;
  return `On ${field.label}, ${top.row.symbol} is the higher of the two at ${field.show(top.value)}, against ${rest.map((entry) => `${entry.row.symbol} at ${field.show(entry.value)}`).join(" and ")}. That is a description of what was recorded, not a judgement about which is the better holding.`;
}

/**
 * The comparison, in prose.
 *
 * Ordered so the answer opens with whatever the user actually singled out, then
 * lays out each company's recorded evidence, then names anything THESIS holds
 * nothing for, and closes on the boundary it must not cross.
 */
export function describeComparison(rows: ComparisonRow[], options: { metric?: ComparisonMetricKey | null; unknown?: string[] } = {}): string {
  const unknown = options.unknown ?? [];
  if (rows.length === 0) {
    return `THESIS holds no recorded market data for ${unknown.length ? unknown.join(" or ") : "those companies"}, so there is nothing of mine to compare. Add one to your watchlist and it will start accumulating observations, or name a company THESIS already follows.`;
  }
  const parts: string[] = [];
  const lead = metricAnswer(rows, options.metric ?? null, unknown);
  if (lead) parts.push(lead);
  parts.push(rows.length === 1
    ? `Here is what THESIS has recorded for ${rows[0].symbol}.`
    : `Here is what THESIS has recorded for ${rows.map((row) => row.symbol).join(" and ")}. Each is shown in its own currency and on its own exchange clock, and nothing is converted between them.`);
  for (const row of rows) {
    const market = marketLine(row.security);
    parts.push(`${row.name ?? row.symbol} (${row.symbol}${market ? `, ${market}` : ""}): ${lines(row).join("; ")}.`);
  }
  if (unknown.length) {
    parts.push(`THESIS holds nothing for ${unknown.join(" and ")}, so ${unknown.length === 1 ? "it is" : "they are"} absent from this comparison rather than estimated.`);
  }
  parts.push("This is recorded evidence, not a recommendation: THESIS does not rank companies or say which to buy.");
  return parts.join(" ");
}

/**
 * "From your THESIS data …" — stored evidence attached to a general answer.
 *
 * Deliberately a separate, labelled block. A general explanation of what a
 * business does and a list of observations this product recorded are different
 * kinds of claim, and a reader has to be able to tell which is which at a
 * glance. Returns null when there is nothing recorded, so a general answer is
 * never padded with an empty section.
 */
export function thesisDataSection(rows: ComparisonRow[]): string | null {
  if (rows.length === 0) return null;
  const parts = rows.map((row) => `${row.symbol} — ${lines(row).join("; ")}.`);
  return `From your THESIS data: ${parts.join(" ")} These are recorded observations, not a view on the business.`;
}
