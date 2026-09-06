import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, priceBars, theses, watchlistItems } from "@/db/schema";
import { replayThesis } from "@/lib/thesis-replay";
import { loadSecurities } from "@/lib/securities-server";
import { exchangeDate } from "@/lib/time";
import type { ThesisParams } from "@/lib/thesis-engine";

/** Sessions the replay walks. Unchanged; only how they are fetched changed. */
const REPLAY_SESSIONS = 160;
/**
 * Membership is checked before any shared history is read. Never backfills.
 *
 * The three reads that follow the membership check do not depend on each other,
 * so they are issued together: the pending corporate action, this security's
 * exchange metadata, and the bars. Chaining them cost three sequential database
 * round trips, which is only free when the database is next door.
 */
export async function getThesisReplay(userId: number, symbol: string) {
  const [thesis] = await db.select({ type: theses.type, params: theses.paramsJson }).from(watchlistItems).leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id)).where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol))).limit(1);
  if (!thesis) return null;
  const [[pending], securities, recent] = await Promise.all([
    db.select({ id: corporateActions.id }).from(corporateActions).where(and(eq(corporateActions.symbol, symbol), eq(corporateActions.status, "VALIDATED"), isNull(corporateActions.appliedAt))).limit(1),
    loadSecurities([symbol]),
    // One extra row, because at most one of these can be the exchange's current
    // session — which is then dropped below, exactly as the SQL predicate did.
    db.select().from(priceBars).where(eq(priceBars.symbol, symbol)).orderBy(desc(priceBars.tradingDate)).limit(REPLAY_SESSIONS + 1),
  ]);
  if (pending) return { ...replayThesis(thesis.type ?? "none", {}, []), status: "insufficient" as const, message: "Replay is unavailable while a validated corporate action awaits reconciliation of your condition." };
  // Exclude today's possibly incomplete daily bar even if a provider supplied
  // one — "today" being that exchange's date, not ours.
  const security = securities.get(symbol)!;
  const today = exchangeDate(new Date(), security.timeZone);
  const bars = recent.filter((bar) => bar.tradingDate < today).slice(0, REPLAY_SESSIONS);
  const number = (v: string | null) => v == null ? null : Number(v);
  return replayThesis(thesis.type ?? "none", (thesis.params ?? {}) as ThesisParams, bars.map((b) => ({ date: b.tradingDate, open: number(b.currentProviderOpen), high: null, low: null, close: number(b.currentProviderClose), adjClose: number(b.currentProviderAdjClose), volume: number(b.currentProviderVolume) })));
}
