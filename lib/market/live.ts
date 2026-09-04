import YahooFinance from "yahoo-finance2";
import { istDate } from "../time";
import type { Bar, MarketDataProvider, Quote, QuoteBatch, SearchResult } from "./types";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

/**
 * Batched quote() resolves ~50 symbols in one HTTP request (Phase 0: 50 symbols,
 * 3.8s, one request). Chunking keeps us to 1–2 requests per poll for the whole
 * universe rather than one request per symbol — the cheapest available mitigation
 * for the datacenter-IP throttling we could not measure from a residential IP.
 */
const BATCH_SIZE = 50;

/**
 * Yahoo's search endpoint is not a complete NSE name directory: for example,
 * searching "infosys" currently returns its NYSE and European listings but
 * omits INFY.NS, although the ticker itself resolves normally. Keep a small
 * local index for the common NSE names users are likely to type, then still
 * validate every selection through `getQuotes` before it reaches a watchlist.
 */
const nseNameFallbacks: SearchResult[] = [
  ["RELIANCE.NS", "Reliance Industries Limited"],
  ["INFY.NS", "Infosys Limited"],
  ["TCS.NS", "Tata Consultancy Services Limited"],
  ["HDFCBANK.NS", "HDFC Bank Limited"],
  ["ICICIBANK.NS", "ICICI Bank Limited"],
  ["BHARTIARTL.NS", "Bharti Airtel Limited"],
  ["ITC.NS", "ITC Limited"],
  ["SBIN.NS", "State Bank of India"],
  ["LT.NS", "Larsen & Toubro Limited"],
  ["HINDUNILVR.NS", "Hindustan Unilever Limited"],
  ["BAJFINANCE.NS", "Bajaj Finance Limited"],
  ["MARUTI.NS", "Maruti Suzuki India Limited"],
  ["SUNPHARMA.NS", "Sun Pharmaceutical Industries Limited"],
  ["TITAN.NS", "Titan Company Limited"],
  ["NTPC.NS", "NTPC Limited"],
  ["POWERGRID.NS", "Power Grid Corporation of India Limited"],
  ["AXISBANK.NS", "Axis Bank Limited"],
  ["KOTAKBANK.NS", "Kotak Mahindra Bank Limited"],
  ["WIPRO.NS", "Wipro Limited"],
  ["TECHM.NS", "Tech Mahindra Limited"],
].map(([symbol, name]) => ({ symbol, name, exchange: "NSE" }));

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

type RawQuote = {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketTime?: Date | number;
  marketState?: string;
  currency?: string;
  longName?: string;
  shortName?: string;
  fullExchangeName?: string;
};

function toQuote(q: RawQuote): Quote | null {
  // A quote without a price or without an exchange timestamp is not a quote we
  // can reason about. Dropping it here is better than letting `null` reach the
  // freshness logic and render as "as of 1 Jan 1970".
  if (q.regularMarketPrice == null || q.regularMarketTime == null) return null;
  return {
    symbol: q.symbol,
    price: q.regularMarketPrice,
    previousClose: q.regularMarketPreviousClose ?? null,
    asOf: new Date(q.regularMarketTime as number),
    marketState: q.marketState ?? null,
    currency: q.currency ?? null,
    name: q.longName ?? q.shortName ?? null,
    exchange: q.fullExchangeName ?? null,
  };
}

export class LiveMarketDataProvider implements MarketDataProvider {
  readonly name = "live" as const;

  /**
   * Fetches quotes and reports exactly which requested symbols did not come back.
   *
   * Yahoo drops unresolvable symbols from a batch silently — no error, no null,
   * no indication which one vanished (Phase 0: 50 requested, 49 returned, the
   * missing one being TATAMOTORS.NS after the demerger). We reconcile by symbol
   * so a vanished symbol becomes a fact the caller has to handle rather than a
   * row that quietly stops updating.
   */
  async getQuotes(symbols: string[]): Promise<QuoteBatch> {
    if (symbols.length === 0) return { quotes: [], missing: [] };

    const requested = [...new Set(symbols)];
    const quotes: Quote[] = [];
    const returned = new Set<string>();

    for (const batch of chunk(requested, BATCH_SIZE)) {
      let raw: RawQuote[];
      try {
        const res = await yf.quote(batch);
        raw = (Array.isArray(res) ? res : [res]) as RawQuote[];
      } catch (err) {
        // A whole failed batch is a feed outage, not a set of delisted symbols.
        // Leaving these out of `returned` would make every symbol in the batch
        // look terminally missing, so we surface the failure instead.
        throw new FeedError(`quote batch of ${batch.length} failed`, { cause: err });
      }
      for (const r of raw) {
        if (!r?.symbol) continue;
        returned.add(r.symbol);
        const q = toQuote(r);
        if (q) quotes.push(q);
      }
    }

    return { quotes, missing: requested.filter((s) => !returned.has(s)) };
  }

  /** Symbol search, restricted to NSE — the universe this product covers. */
  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 1) return [];

    const res = await yf.search(trimmed, { newsCount: 0, quotesCount: 20 });
    const quotes = (res.quotes ?? []) as unknown as {
      symbol?: string; shortname?: string; longname?: string;
      exchange?: string; quoteType?: string; isYahooFinance?: boolean;
    }[];

    const providerMatches = quotes
      .filter((q) => q.isYahooFinance !== false)
      .filter((q) => q.quoteType === "EQUITY")
      .filter((q) => q.symbol?.endsWith(".NS"))
      .map((q) => ({
        symbol: q.symbol!,
        name: q.longname ?? q.shortname ?? null,
        exchange: q.exchange ?? null,
      }));
    const queryLower = trimmed.toLowerCase();
    const fallbackMatches = nseNameFallbacks.filter((result) =>
      result.symbol.toLowerCase().includes(queryLower) || result.name?.toLowerCase().includes(queryLower),
    );

    return [...providerMatches, ...fallbackMatches]
      .filter((result, index, all) => all.findIndex((other) => other.symbol === result.symbol) === index)
      .slice(0, 10);
  }

  /**
   * Daily bars. Always requests a long window and slices locally, because short
   * windows return a single bar for several NSE indices with no error at all
   * (Phase 0: ^CNXAUTO returned 1 bar for 30 days, 501 bars for 730 days).
   */
  async getDailyBars(symbol: string, sinceDays: number): Promise<Bar[]> {
    const window = Math.max(sinceDays, 400);
    const res = await yf.chart(symbol, {
      period1: new Date(Date.now() - window * 864e5),
      interval: "1d",
    });
    const cutoff = istDate(new Date(Date.now() - sinceDays * 864e5));
    return (res.quotes as unknown as {
      date: Date; open: number | null; high: number | null; low: number | null;
      close: number | null; volume: number | null; adjclose?: number | null;
    }[])
      .map((b) => ({
        date: istDate(new Date(b.date)),
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, adjClose: b.adjclose ?? null,
      }))
      .filter((b) => b.date >= cutoff);
  }
}

export class FeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FeedError";
  }
}

export const liveProvider = new LiveMarketDataProvider();
