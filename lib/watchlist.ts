import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { quotes, symbols, theses, watchlistItems } from "@/db/schema";
import { liveProvider } from "@/lib/market/live";
import { classify, type FeedHealth } from "@/lib/feed-health";
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
  thesisState: string | null;
  health: FeedHealth;
};

/**
 * Reads the watchlist from stored state. Deliberately does NOT call the feed.
 *
 * Page loads used to fetch quotes inline. That is the wrong shape for the
 * deployed app: it makes request volume a function of user traffic rather than
 * of a fixed schedule, which is exactly the pattern most likely to trip the
 * datacenter-IP throttling the brief warns about — and which our residential-IP
 * testing could not measure. The scheduled ingestion route is now the only
 * writer of quotes; this path renders what it committed.
 *
 * That is also what "serve last-known-good with a visible as-of timestamp"
 * means in practice. Every row carries the exchange timestamp of the price
 * shown, and the UI states its age rather than implying it is live.
 */
export async function getWatchlist(userId: number): Promise<WatchlistRow[]> {
  const rows = await db
    .select({
      symbol: watchlistItems.symbol,
      addedAt: watchlistItems.createdAt,
      name: symbols.name,
      misses: symbols.consecutiveFeedMisses,
      price: quotes.price,
      previousClose: quotes.previousClose,
      asOf: quotes.asOf,
      marketState: quotes.marketState,
      thesisState: theses.state,
    })
    .from(watchlistItems)
    .innerJoin(symbols, eq(symbols.symbol, watchlistItems.symbol))
    .leftJoin(quotes, eq(quotes.symbol, watchlistItems.symbol))
    .leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
    .where(eq(watchlistItems.userId, userId))
    .orderBy(watchlistItems.createdAt);

  return rows.map((row) => {
    const price = row.price == null ? null : Number(row.price);
    const prev = row.previousClose == null ? null : Number(row.previousClose);
    return {
      symbol: row.symbol,
      name: row.name,
      addedAt: row.addedAt,
      price,
      previousClose: prev,
      changePercent:
        price != null && prev != null && prev !== 0 ? ((price - prev) / prev) * 100 : null,
      asOf: row.asOf ?? null,
      marketState: row.marketState ?? null,
      thesisState: row.thesisState ?? null,
      health: classify(row.misses),
    };
  });
}

export type AddResult = { ok: true; watchlistItemId: number } | { ok: false; error: string };

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

  // The validation fetch already produced a usable quote. Persisting it here is
  // what lets a just-added symbol render a price before the next scheduled poll.
  await db
    .insert(quotes)
    .values({
      symbol: resolved.symbol,
      price: String(resolved.price),
      previousClose: resolved.previousClose == null ? null : String(resolved.previousClose),
      asOf: resolved.asOf,
      marketState: resolved.marketState,
      fetchedAt: new Date(),
    })
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

  try {
    const [row] = await db.insert(watchlistItems)
      .values({ userId, symbol: resolved.symbol })
      .returning({ id: watchlistItems.id });
    return { ok: true, watchlistItemId: row.id };
  } catch (err) {
    // Unique constraint — already on the list. Idempotent, so not an error:
    // return the existing item so a thesis can still be attached to it.
    if (isUniqueViolation(err)) {
      const [existing] = await db.select({ id: watchlistItems.id }).from(watchlistItems)
        .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, resolved.symbol)))
        .limit(1);
      return { ok: true, watchlistItemId: existing.id };
    }
    throw err;
  }
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
