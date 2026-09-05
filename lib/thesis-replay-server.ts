import "server-only";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { corporateActions, priceBars, theses, watchlistItems } from "@/db/schema";
import { replayThesis } from "@/lib/thesis-replay";
import { loadSecurities } from "@/lib/securities-server";
import { exchangeDate } from "@/lib/time";
import type { ThesisParams } from "@/lib/thesis-engine";
/** Membership is checked before accessing shared history. Never backfills. */
export async function getThesisReplay(userId: number, symbol: string) {
  const [thesis] = await db.select({ type: theses.type, params: theses.paramsJson }).from(watchlistItems).leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id)).where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol))).limit(1);
  if (!thesis) return null;
  const [pending] = await db.select({ id: corporateActions.id }).from(corporateActions).where(and(eq(corporateActions.symbol, symbol), eq(corporateActions.status, "VALIDATED"), isNull(corporateActions.appliedAt))).limit(1);
  if (pending) return { ...replayThesis(thesis.type ?? "none", {}, []), status: "insufficient" as const, message: "Replay is unavailable while a validated corporate action awaits reconciliation of your condition." };
  // Exclude today's possibly incomplete daily bar even if a provider supplied
  // one — "today" being that exchange's date, not ours.
  const security = (await loadSecurities([symbol])).get(symbol)!;
  const bars = await db.select().from(priceBars).where(and(eq(priceBars.symbol, symbol), lt(priceBars.tradingDate, exchangeDate(new Date(), security.timeZone)))).orderBy(desc(priceBars.tradingDate)).limit(160);
  const number = (v: string | null) => v == null ? null : Number(v);
  return replayThesis(thesis.type ?? "none", (thesis.params ?? {}) as ThesisParams, bars.map((b) => ({ date: b.tradingDate, open: number(b.currentProviderOpen), high: null, low: null, close: number(b.currentProviderClose), adjClose: number(b.currentProviderAdjClose), volume: number(b.currentProviderVolume) })));
}
