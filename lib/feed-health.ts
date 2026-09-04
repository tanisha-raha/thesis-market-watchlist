/**
 * Transient vs terminal feed misses.
 *
 * Batched quote() silently drops symbols it cannot resolve. One miss in one poll
 * means very little — a hiccup, a partial response, a symbol momentarily absent.
 * Misses across several consecutive polls mean something structural: a delisting,
 * a rename, or a demerger (TATAMOTORS.NS, which stopped resolving after the Tata
 * Motors demerger, is the case we found in Phase 0).
 *
 * The distinction matters more here than in a normal app. This product's whole
 * promise is "we are watching this for you". Telling a user we stopped watching
 * is the most alarming message we can send, so sending it on a single blip would
 * be a false alarm on precisely the guarantee we are making. Equally, never
 * sending it means a delisted symbol goes quiet forever and the user believes
 * they are covered when they are not.
 *
 * So: count quietly, escalate only on repetition.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@/db";
import { symbols } from "@/db/schema";

/**
 * Consecutive polls a symbol must be absent from before we treat it as terminal.
 * Three is a judgement call, not a derived constant: enough that a single
 * degraded response stays invisible, few enough that a genuine delisting
 * surfaces within one trading session at our polling cadence.
 */
export const TERMINAL_MISS_THRESHOLD = 3;

export type FeedHealth = "ok" | "degraded" | "unresolved";

export function classify(consecutiveMisses: number): FeedHealth {
  if (consecutiveMisses === 0) return "ok";
  if (consecutiveMisses < TERMINAL_MISS_THRESHOLD) return "degraded";
  return "unresolved";
}

/** Whether this state is worth telling the user about. Only terminal states are. */
export function isUserVisible(health: FeedHealth): boolean {
  return health === "unresolved";
}

/**
 * Records the outcome of one poll.
 *
 * Called with the symbols that came back and the ones that did not. A whole-batch
 * feed failure must NOT reach here — that would mark every symbol in the batch as
 * missing and escalate the entire watchlist to "unresolved" on one bad request.
 * `LiveMarketDataProvider.getQuotes` throws on batch failure for that reason.
 *
 * Takes an explicit executor. When called inside an ingestion transaction it must
 * receive that transaction, or these writes commit independently and a rolled-back
 * batch still advances the miss counters — pushing a symbol toward a false
 * "we stopped monitoring this", which is the most alarming thing we can tell a user.
 */
export async function recordPollOutcome(
  executor: DbExecutor,
  seen: string[],
  missing: string[],
): Promise<void> {
  const now = new Date();
  if (seen.length > 0) {
    await executor.update(symbols)
      .set({ lastSeenInFeedAt: now, consecutiveFeedMisses: 0 })
      .where(inArray(symbols.symbol, seen));
  }
  if (missing.length > 0) {
    await executor.update(symbols)
      .set({ consecutiveFeedMisses: sql`${symbols.consecutiveFeedMisses} + 1` })
      .where(inArray(symbols.symbol, missing));
  }
}

/** Resets a symbol's miss counter — used when a user re-adds or we confirm a resolve. */
export async function clearMisses(symbol: string): Promise<void> {
  await db.update(symbols)
    .set({ consecutiveFeedMisses: 0, lastSeenInFeedAt: new Date() })
    .where(eq(symbols.symbol, symbol));
}
