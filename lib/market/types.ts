/** The seam between the app and the market data feed. */

export type Quote = {
  symbol: string;
  price: number;
  previousClose: number | null;
  /** The exchange's own timestamp, not our fetch time. Freshness lives here. */
  asOf: Date;
  marketState: string | null;
  currency: string | null;
  name: string | null;
  exchange: string | null;
};

export type Bar = {
  /** IST trading date, YYYY-MM-DD. A calendar fact, not an instant. */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  adjClose: number | null;
};

export type SearchResult = {
  symbol: string;
  name: string | null;
  exchange: string | null;
};

/**
 * The result of a batched quote fetch.
 *
 * `missing` is not an error case to be swallowed — batched quote() silently
 * drops symbols it cannot resolve (Phase 0), so the caller MUST be handed the
 * difference between what it asked for and what came back. Returning only
 * `quotes` would reproduce exactly the silent failure we are guarding against.
 */
export type QuoteBatch = {
  quotes: Quote[];
  missing: string[];
};

export interface MarketDataProvider {
  readonly name: "live" | "replay";
  getQuotes(symbols: string[]): Promise<QuoteBatch>;
  search(query: string): Promise<SearchResult[]>;
  getDailyBars(symbol: string, sinceDays: number): Promise<Bar[]>;
}
