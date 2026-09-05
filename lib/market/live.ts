import YahooFinance from "yahoo-finance2";
import { exchangeDate, IST } from "../time";
import { REGIONS, exchangeFromCode, isSupportedExchangeCode } from "../securities";
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
 * Yahoo's search endpoint is not a complete NSE name directory: searching
 * "Infosys" returns the NYSE ADR and the BSE line but omits INFY.NS, although
 * the ticker itself resolves normally. US names need no such help — "Apple",
 * "BlackRock" and "NVIDIA" all come back correctly — so this stays a targeted
 * patch for the one market the provider indexes poorly, not a symbol directory
 * of our own. Every selection is still validated through `getQuotes` before it
 * reaches a watchlist.
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
].map(([symbol, name]) => ({ symbol, name, exchange: "NSE", market: REGIONS.IN.short }));

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
  exchange?: string;
  fullExchangeName?: string;
  exchangeTimezoneName?: string;
};

export function toQuote(q: RawQuote): Quote | null {
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
    // The exchange code is the stable identity ("NMS"); the full name is a
    // marketing label that varies ("NasdaqGS", "Nasdaq GIDS"). Prefer the code
    // where we recognise it, and keep the provider's own name otherwise.
    exchange: exchangeFromCode(q.exchange)?.exchange ?? q.fullExchangeName ?? q.exchange ?? null,
    timeZone: q.exchangeTimezoneName ?? null,
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

  /** One company search for the whole product: every supported exchange, one list. */
  async search(query: string): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length < 1) return [];
    const res = await yf.search(trimmed, { newsCount: 0, quotesCount: 20 });
    return searchResultsFrom((res.quotes ?? []) as unknown as RawSearchQuote[], trimmed);
  }

  /**
   * Daily bars. Always requests a long window and slices locally, because short
   * windows return a single bar for several NSE indices with no error at all
   * (Phase 0: ^CNXAUTO returned 1 bar for 30 days, 501 bars for 730 days).
   *
   * Trading dates are keyed in the EXCHANGE's zone, from the chart's own
   * metadata. Keying a NASDAQ session by its IST date would push any bar
   * stamped after 18:30 UTC onto the following calendar day and silently
   * misalign every US series against its benchmark.
   */
  async getDailyBars(symbol: string, sinceDays: number): Promise<Bar[]> {
    const window = Math.max(sinceDays, 400);
    const res = await yf.chart(symbol, {
      period1: new Date(Date.now() - window * 864e5),
      interval: "1d",
    });
    const zone = (res.meta as { exchangeTimezoneName?: string } | undefined)?.exchangeTimezoneName ?? IST;
    const cutoff = exchangeDate(new Date(Date.now() - sinceDays * 864e5), zone);
    return (res.quotes as unknown as {
      date: Date; open: number | null; high: number | null; low: number | null;
      close: number | null; volume: number | null; adjclose?: number | null;
    }[])
      .map((b) => ({
        date: exchangeDate(new Date(b.date), zone),
        open: b.open, high: b.high, low: b.low, close: b.close,
        volume: b.volume, adjClose: b.adjclose ?? null,
      }))
      .filter((b) => b.date >= cutoff);
  }
}

export type RawSearchQuote = {
  symbol?: string; shortname?: string; longname?: string;
  exchange?: string; quoteType?: string; isYahooFinance?: boolean;
};

/**
 * Turns a raw provider search response into the product's result list.
 *
 * Pure, so "does searching BlackRock return BLK on NYSE" is a test rather than a
 * manual click. Two rules do the work:
 *
 *   SUPPORTED EXCHANGES ONLY. Yahoo answers "Apple" with XETRA, Buenos Aires and
 *   São Paulo cross-listings. Each is a real security with its own currency and
 *   calendar, and offering them would promise coverage we have not validated.
 *
 *   INDIAN NAME FALLBACKS RANK FIRST. They only exist because the provider omits
 *   the NSE line for names it indexes poorly, so when one matches it is the
 *   listing the user meant — "Infosys" should reach INFY.NS, not only the ADR.
 */
export function searchResultsFrom(quotes: RawSearchQuote[], query: string): SearchResult[] {
  const providerMatches = quotes
    .filter((q) => q.isYahooFinance !== false)
    .filter((q) => q.quoteType === "EQUITY")
    .filter((q) => q.symbol && isSupportedExchangeCode(q.exchange))
    .map((q) => {
      const info = exchangeFromCode(q.exchange)!;
      return {
        symbol: q.symbol!,
        name: q.longname ?? q.shortname ?? null,
        exchange: info.exchange,
        market: REGIONS[info.region].short,
      };
    });

  const needle = query.trim().toLowerCase();
  const fallbackMatches = nseNameFallbacks.filter((result) =>
    result.symbol.toLowerCase().includes(needle) || result.name?.toLowerCase().includes(needle),
  );

  return [...fallbackMatches, ...providerMatches]
    .filter((result, index, all) => all.findIndex((other) => other.symbol === result.symbol) === index)
    .slice(0, 10);
}

export class FeedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FeedError";
  }
}

export const liveProvider = new LiveMarketDataProvider();
