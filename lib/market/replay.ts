import type { Bar, MarketDataProvider, Quote, QuoteBatch, SearchResult } from "./types";

/**
 * Deterministic market data, from fixtures rather than the network.
 *
 * Not a test shortcut. It is what makes the 18 Sep demo reproducible when a free
 * API rate-limits us, and it is how the missed-event replay is demonstrated
 * without depending on the market happening to cooperate on the day.
 *
 * It models the provider's real failure modes rather than an idealised feed:
 * a symbol absent from the fixture is reported as `missing` exactly as Yahoo
 * silently drops unresolvable symbols from a batch, and `failOn` can make a
 * whole batch throw the way a feed outage does.
 */
export class ReplayMarketDataProvider implements MarketDataProvider {
  readonly name = "replay" as const;

  constructor(
    private readonly data: {
      quotes?: Record<string, Quote>;
      bars?: Record<string, Bar[]>;
      search?: SearchResult[];
      /** When set, every getQuotes call throws — models a feed outage. */
      failOn?: Error;
    } = {},
  ) {}

  async getQuotes(symbols: string[]): Promise<QuoteBatch> {
    if (this.data.failOn) throw this.data.failOn;

    const available = this.data.quotes ?? {};
    const requested = [...new Set(symbols)];
    const quotes = requested.map((s) => available[s]).filter((q): q is Quote => q != null);
    const returned = new Set(quotes.map((q) => q.symbol));

    return { quotes, missing: requested.filter((s) => !returned.has(s)) };
  }

  async search(query: string): Promise<SearchResult[]> {
    const all = this.data.search ?? [];
    const q = query.trim().toUpperCase();
    return q ? all.filter((r) => r.symbol.includes(q) || (r.name ?? "").toUpperCase().includes(q)) : all;
  }

  /** `sinceDays` is a day count, so slicing is by trading date rather than by row. */
  async getDailyBars(symbol: string, sinceDays: number): Promise<Bar[]> {
    const bars = this.data.bars?.[symbol] ?? [];
    const cutoff = new Date(Date.now() - sinceDays * 864e5).toISOString().slice(0, 10);
    return bars.filter((b) => b.date >= cutoff);
  }
}
