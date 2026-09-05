/**
 * Security metadata — the one place that decides what market a symbol belongs to.
 *
 * THESIS is not an NSE product with foreign symbols bolted on. Every surface that
 * needs an exchange, a currency, a timezone or a benchmark asks this module, so
 * "add another exchange" is a row in a table here rather than an edit across the
 * watchlist, digest, detection and replay layers.
 *
 * PROVIDER METADATA IS AUTHORITATIVE. Yahoo returns `currency`,
 * `exchangeTimezoneName` and an exchange code on every quote (verified: AAPL →
 * USD/America/New_York/NMS, INFY.NS → INR/Asia/Kolkata/NSI). We store what it
 * tells us and only fall back to inference — exchange name, then currency, then
 * the ticker suffix — for rows written before we captured it. Inference is the
 * fallback, never the first answer.
 *
 * Pure. No database, no network, no server-only import: the deterministic
 * engines, the UI and the test suite all read the same definitions.
 */

import { exchangeDate, zonedInstant } from "./time";

export type MarketRegion = "IN" | "US";

export type RegionInfo = {
  code: MarketRegion;
  /** Full name, for section headings. */
  label: string;
  /** Compact name, for inline metadata like "NYSE · US". */
  short: string;
  timeZone: string;
  /**
   * The index a stock's move is measured against. Comparing AAPL to NIFTY 50
   * would be a category error, so benchmark-relative evidence is regional or it
   * is withheld entirely.
   */
  benchmark: string;
  /** Regular session, exchange-local. Used to date a daily bar as an instant. */
  sessionOpen: [number, number];
  sessionClose: [number, number];
};

export const REGIONS: Record<MarketRegion, RegionInfo> = {
  IN: {
    code: "IN", label: "India", short: "India", timeZone: "Asia/Kolkata",
    benchmark: "^NSEI", sessionOpen: [9, 15], sessionClose: [15, 30],
  },
  US: {
    code: "US", label: "United States", short: "US", timeZone: "America/New_York",
    benchmark: "^GSPC", sessionOpen: [9, 30], sessionClose: [16, 0],
  },
};

export const REGION_ORDER: MarketRegion[] = ["IN", "US"];

/**
 * Provider exchange codes we surface in search.
 *
 * Deliberately an allowlist rather than "anything Yahoo returns": a Frankfurt or
 * São Paulo cross-listing of the same company resolves fine but has a different
 * currency, calendar and benchmark, and offering it would promise coverage we
 * have not validated. A symbol outside this list can still be added by ticker —
 * it just renders from whatever metadata the provider supplies.
 */
const EXCHANGE_BY_CODE: Record<string, { exchange: string; region: MarketRegion }> = {
  NSI: { exchange: "NSE", region: "IN" },
  BSE: { exchange: "BSE", region: "IN" },
  NMS: { exchange: "NASDAQ", region: "US" },
  NGM: { exchange: "NASDAQ", region: "US" },
  NCM: { exchange: "NASDAQ", region: "US" },
  NAS: { exchange: "NASDAQ", region: "US" },
  NYQ: { exchange: "NYSE", region: "US" },
};

/**
 * Provider "full exchange name" values, which is what `symbols.exchange` already
 * holds for rows written before this module existed. Keyed lowercase so
 * "NasdaqGS", "Nasdaq GIDS" and "NASDAQ" all land in the same place.
 */
const EXCHANGE_BY_NAME: Record<string, { exchange: string; region: MarketRegion }> = {
  nse: { exchange: "NSE", region: "IN" },
  nsi: { exchange: "NSE", region: "IN" },
  bse: { exchange: "BSE", region: "IN" },
  bombay: { exchange: "BSE", region: "IN" },
  nyse: { exchange: "NYSE", region: "US" },
  nyq: { exchange: "NYSE", region: "US" },
  snp: { exchange: "S&P", region: "US" },
  dji: { exchange: "Dow Jones", region: "US" },
};

export function exchangeFromCode(code: string | null | undefined) {
  return code ? EXCHANGE_BY_CODE[code.toUpperCase()] ?? null : null;
}

/** Is this an exchange the product actively supports in search? */
export function isSupportedExchangeCode(code: string | null | undefined): boolean {
  return exchangeFromCode(code) != null;
}

function exchangeFromName(name: string | null | undefined) {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (EXCHANGE_BY_NAME[key]) return EXCHANGE_BY_NAME[key];
  if (key.startsWith("nasdaq")) return { exchange: "NASDAQ", region: "US" as const };
  if (key.startsWith("nyse")) return { exchange: "NYSE", region: "US" as const };
  return null;
}

function regionFromTimeZone(timeZone: string | null | undefined): MarketRegion | null {
  if (!timeZone) return null;
  for (const region of REGION_ORDER) if (REGIONS[region].timeZone === timeZone) return region;
  return null;
}

export type SecurityInput = {
  symbol: string;
  name?: string | null;
  /** Provider exchange code (NSI, NMS, NYQ …) or full name (NSE, NasdaqGS …). */
  exchange?: string | null;
  currency?: string | null;
  /** IANA zone from the provider. The authoritative answer when present. */
  timeZone?: string | null;
};

export type Security = {
  symbol: string;
  name: string | null;
  /** What the user sees: NSE, BSE, NASDAQ, NYSE — or the provider's own name. */
  exchange: string | null;
  region: MarketRegion | null;
  /** "India" / "US", for inline metadata. Null when the market is unknown. */
  marketLabel: string | null;
  /** Native trading currency. Never converted, never aggregated across symbols. */
  currency: string | null;
  /** Exchange-local zone for rendering timestamps. Falls back to UTC, labelled as such. */
  timeZone: string;
  /** False when we are rendering in UTC because we do not know the exchange zone. */
  timeZoneKnown: boolean;
  /** The regional index, or null when we have no honest benchmark for this symbol. */
  benchmark: string | null;
};

/**
 * Resolves everything the app needs to know about one security.
 *
 * Falls through provider metadata → exchange identity → currency → ticker
 * suffix, and stops at "unknown" rather than guessing India, which is what every
 * hardcoded ₹ and IST in the original build effectively did.
 */
export function describeSecurity(input: SecurityInput): Security {
  const exchangeInfo = exchangeFromCode(input.exchange) ?? exchangeFromName(input.exchange);
  const region: MarketRegion | null =
    regionFromTimeZone(input.timeZone) ??
    exchangeInfo?.region ??
    (input.currency === "INR" ? "IN" : input.currency === "USD" ? "US" : null) ??
    (/\.(NS|BO)$/i.test(input.symbol) ? "IN" : null);

  const info = region ? REGIONS[region] : null;
  const timeZone = input.timeZone ?? info?.timeZone ?? null;

  return {
    symbol: input.symbol,
    name: input.name ?? null,
    exchange: exchangeInfo?.exchange ?? (input.exchange?.trim() || null),
    region,
    marketLabel: info?.short ?? null,
    currency: input.currency ?? (region === "IN" ? "INR" : region === "US" ? "USD" : null),
    timeZone: timeZone ?? "UTC",
    timeZoneKnown: timeZone != null,
    benchmark: info?.benchmark ?? null,
  };
}

/** "NSE · India", "NASDAQ · US" — or as much of it as we actually know. */
export function marketLine(security: Security): string {
  return [security.exchange, security.marketLabel].filter(Boolean).join(" · ");
}

export const BENCHMARK_SYMBOLS = REGION_ORDER.map((region) => REGIONS[region].benchmark);

export function isBenchmarkSymbol(symbol: string): boolean {
  return BENCHMARK_SYMBOLS.includes(symbol);
}

/**
 * The native-currency renderer. One symbol, one currency, never converted:
 * a watchlist holding INFY.NS and AAPL shows ₹ and $ side by side because those
 * are the units those securities actually trade in.
 */
export function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const locale = currency === "INR" ? "en-IN" : "en-US";
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (!currency) return new Intl.NumberFormat(locale, digits).format(value);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, ...digits }).format(value);
  } catch {
    // An unknown ISO code is still a number in a currency: say which one rather
    // than dropping the unit or borrowing someone else's symbol.
    return `${new Intl.NumberFormat(locale, digits).format(value)} ${currency}`;
  }
}

/**
 * The trading session an instant falls in, on that security's exchange.
 *
 * The missed-event card draws an event against its session, and a session is a
 * local fact: 09:15–15:30 in Mumbai, 09:30–16:00 in New York. Drawing a NASDAQ
 * event on an NSE session bar would place it outside the bar entirely.
 */
export function sessionWindow(security: Pick<Security, "region" | "timeZone">, at: Date) {
  const region = REGIONS[security.region ?? "IN"];
  const date = exchangeDate(at, security.timeZone);
  const clock = ([h, m]: [number, number]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return {
    date,
    open: zonedInstant(date, security.timeZone, ...region.sessionOpen),
    close: zonedInstant(date, security.timeZone, ...region.sessionClose),
    openLabel: clock(region.sessionOpen),
    closeLabel: clock(region.sessionClose),
  };
}

/** Volume and other counts, in the security's own regional grouping convention. */
export function formatCount(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US").format(value);
}
