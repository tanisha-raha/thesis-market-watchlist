import { REGIONS, type MarketRegion } from "./securities";
import type { Quote } from "./market/types";

/**
 * The two markets THESIS covers, and the indices that describe them.
 *
 * Deliberately six, not sixteen. Each one is a symbol the provider actually
 * resolves (verified: ^NSEI, ^BSESN, ^NSEBANK, ^GSPC, ^IXIC, ^DJI), and adding
 * FTSE or Nikkei would advertise coverage the rest of the product — search,
 * benchmarks, calendars — has not been validated for.
 */
export const MARKET_INDICES: { symbol: string; name: string; region: MarketRegion }[] = [
  { symbol: "^NSEI", name: "NIFTY 50", region: "IN" },
  { symbol: "^BSESN", name: "SENSEX", region: "IN" },
  { symbol: "^NSEBANK", name: "NIFTY BANK", region: "IN" },
  { symbol: "^GSPC", name: "S&P 500", region: "US" },
  { symbol: "^IXIC", name: "NASDAQ Composite", region: "US" },
  { symbol: "^DJI", name: "Dow Jones", region: "US" },
];

/**
 * The name people use for an index, from the same table the market pulse renders.
 *
 * One source for "^NSEI is NIFTY 50", so evidence, digests and Home cannot drift
 * apart — and a provider ticker never reaches a user-facing label. An index we do
 * not carry falls back to its symbol rather than to a guess.
 */
export function indexDisplayName(symbol: string): string {
  return MARKET_INDICES.find((index) => index.symbol === symbol)?.name ?? symbol;
}

/** The index whose reported state stands for its market's session. */
export const REGION_PRIMARY_INDEX: Record<MarketRegion, string> = {
  IN: "^NSEI",
  US: "^GSPC",
};

export function indexValue(quote: Quote | undefined) {
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(new Date(quote.asOf).getTime())) return null;
  const change = quote.previousClose != null && Number.isFinite(quote.previousClose) && quote.previousClose > 0 ? quote.price - quote.previousClose : null;
  return { ...quote, asOf: new Date(quote.asOf), change, percent: change == null ? null : change / quote.previousClose! * 100 };
}

export type MarketStatus = "OPEN" | "CLOSED" | "PRE-MARKET" | "AFTER HOURS" | null;

/**
 * A market's session state, from the provider's own `marketState`.
 *
 * Null when the provider did not tell us — and null means the UI shows
 * freshness instead of a guess. "MARKET CLOSED" spanning every market at once
 * was the original sin here: India and the US are shut and open at different
 * times of the same day, so one label could only ever be right for one of them.
 */
export function marketStatusFrom(marketState: string | null | undefined): MarketStatus {
  if (!marketState) return null;
  const state = marketState.toUpperCase();
  if (state === "REGULAR") return "OPEN";
  if (state === "PRE" || state === "PREPRE") return "PRE-MARKET";
  if (state === "POST" || state === "POSTPOST") return "AFTER HOURS";
  if (state === "CLOSED") return "CLOSED";
  return null;
}

/** "INDIA CLOSED · US OPEN" — each market answering for itself. */
export function marketStatusLine(statuses: { region: MarketRegion; status: MarketStatus }[]): string | null {
  const parts = statuses.flatMap((s) => (s.status ? [`${REGIONS[s.region].short.toUpperCase()} ${s.status}`] : []));
  return parts.length ? parts.join(" · ") : null;
}

export type NewsItem = { title: string; source: string; url: string; publishedAt: string; category: "Markets" };

/** Presentation only. No inference, causal attribution, or HTML rendering. */
export function normalizeNews(items: { title?: unknown; publisher?: unknown; link?: unknown; providerPublishTime?: unknown }[], now = new Date()): NewsItem[] {
  const seen = new Set<string>();
  return items.flatMap((item): NewsItem[] => {
    if (typeof item.title !== "string" || !item.title.trim() || typeof item.publisher !== "string" || !item.publisher.trim() || typeof item.link !== "string") return [];
    let url: URL;
    try { url = new URL(item.link); } catch { return []; }
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return [];
    const date = new Date(item.providerPublishTime as string);
    const age = now.getTime() - date.getTime();
    if (!Number.isFinite(age) || age < -300000 || age > 72 * 3600000 || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ title: item.title.slice(0, 240), source: item.publisher.slice(0, 80), url: url.href, publishedAt: date.toISOString(), category: "Markets" }];
  }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 6);
}

export async function bounded<T>(work: Promise<T>, milliseconds = 7000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Presentation provider timeout")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
