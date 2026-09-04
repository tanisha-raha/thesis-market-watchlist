import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { quotes, symbols, watchlistItems } from "@/db/schema";
import { liveProvider } from "@/lib/market/live";
import { classify, recordPollOutcome, type FeedHealth } from "@/lib/feed-health";
import { isUniqueViolation } from "@/lib/db-errors";

/** `excluded.<col>` in an ON CONFLICT DO UPDATE — the row Postgres tried to insert. */
const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);

export type WatchlistRow = {
  symbol: string;
  name: string | null;
  addedAt: Date;
  price: number | null;
  previousClose: number | null;
  changePercent: number | null;
  /** Exchange timestamp for the price shown. Null when we have never had a quote. */
  asOf: Date | null;
  marketState: string | null;
  health: FeedHealth;
  /** True when the price came from storage because the live feed did not answer. */
  servedFromCache: boolean;
};

/**
 * Refreshes quotes for a set of symbols, returning what we know either way.
 *
 * Two resilience rules from the brief are load-bearing here:
 *   1. Never render stale data as live — every row carries its own `asOf` and a
 *      `servedFromCache` flag, and the UI shows both.
 *   2. A feed outage degrades the page, it does not break it. On a failed fetch
 *      we fall back to last-known-good rather than showing an error screen.
 */
async function refreshQuotes(syms: string[]): Promise<{ failed: boolean }> {
  if (syms.length === 0) return { failed: false };

  try {
    const { quotes: fresh, missing } = await liveProvider.getQuotes(syms);

    if (fresh.length > 0) {
      await db.insert(quotes)
        .values(fresh.map((q) => ({
          symbol: q.symbol,
          price: String(q.price),
          previousClose: q.previousClose == null ? null : String(q.previousClose),
          asOf: q.asOf,
          marketState: q.marketState,
          fetchedAt: new Date(),
        })))
        .onConflictDoUpdate({
          target: quotes.symbol,
          set: {
            price: sqlExcluded("price"),
            previousClose: sqlExcluded("previous_close"),
            asOf: sqlExcluded("as_of"),
            marketState: sqlExcluded("market_state"),
            fetchedAt: sqlExcluded("fetched_at"),
          },
        });
    }

    await recordPollOutcome(fresh.map((q) => q.symbol), missing);
    return { failed: false };
  } catch {
    // Feed outage. Deliberately not rethrown and deliberately not counted as a
    // per-symbol miss — see the note in lib/feed-health.ts.
    return { failed: true };
  }
}

export async function getWatchlist(userId: number): Promise<WatchlistRow[]> {
  const items = await db
    .select({
      symbol: watchlistItems.symbol,
      addedAt: watchlistItems.createdAt,
      name: symbols.name,
      misses: symbols.consecutiveFeedMisses,
    })
    .from(watchlistItems)
    .innerJoin(symbols, eq(symbols.symbol, watchlistItems.symbol))
    .where(eq(watchlistItems.userId, userId))
    .orderBy(watchlistItems.createdAt);

  if (items.length === 0) return [];

  const { failed } = await refreshQuotes(items.map((i) => i.symbol));

  const stored = await db
    .select()
    .from(quotes)
    .where(inArray(quotes.symbol, items.map((i) => i.symbol)));
  const bySymbol = new Map(stored.map((q) => [q.symbol, q]));

  return items.map((item) => {
    const q = bySymbol.get(item.symbol);
    const price = q ? Number(q.price) : null;
    const prev = q?.previousClose == null ? null : Number(q.previousClose);
    return {
      symbol: item.symbol,
      name: item.name,
      addedAt: item.addedAt,
      price,
      previousClose: prev,
      changePercent: price != null && prev != null && prev !== 0 ? (price - prev) / prev * 100 : null,
      asOf: q?.asOf ?? null,
      marketState: q?.marketState ?? null,
      health: classify(item.misses),
      servedFromCache: failed,
    };
  });
}

export type AddResult = { ok: true } | { ok: false; error: string };

/**
 * Adds a symbol to a user's watchlist.
 *
 * Validates against the live feed first: an unresolvable symbol must never enter
 * the watchlist, because from that moment on the product would be claiming to
 * monitor something it cannot see.
 */
export async function addSymbol(userId: number, rawSymbol: string): Promise<AddResult> {
  const symbol = rawSymbol.trim().toUpperCase();
  if (!symbol) return { ok: false, error: "Enter a symbol." };

  let resolved;
  try {
    const { quotes: found } = await liveProvider.getQuotes([symbol]);
    resolved = found[0];
  } catch {
    return { ok: false, error: "Market data is unavailable right now. Try again in a moment." };
  }
  if (!resolved) return { ok: false, error: `We could not resolve ${symbol} on NSE.` };

  await db.insert(symbols)
    .values({
      symbol: resolved.symbol,
      name: resolved.name,
      exchange: resolved.exchange,
      currency: resolved.currency,
      lastSeenInFeedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: symbols.symbol,
      set: { name: sqlExcluded("name"), lastSeenInFeedAt: sqlExcluded("last_seen_in_feed_at"), consecutiveFeedMisses: sql`0` },
    });

  try {
    await db.insert(watchlistItems).values({ userId, symbol: resolved.symbol });
  } catch (err) {
    // Unique constraint — already on the list. Idempotent, so not an error.
    if (isUniqueViolation(err)) return { ok: true };
    throw err;
  }
  return { ok: true };
}

export async function removeSymbol(userId: number, symbol: string): Promise<void> {
  await db.delete(watchlistItems)
    .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol)));
}

export async function searchSymbols(query: string) {
  try {
    return await liveProvider.search(query);
  } catch {
    return [];
  }
}
