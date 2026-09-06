import "server-only";
import { cache } from "react";
import { and, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, priceBars, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { evidenceFrom } from "@/lib/digest";

/** Read-only presentation queries. No fetches, inference, or ingestion here. */
export const getPresentationData = cache(async function getPresentationData(userId: number) {
  const thesisRows = await db
    .select({ symbol: watchlistItems.symbol, id: theses.id, type: theses.type, state: theses.state,
      params: theses.paramsJson, note: theses.note, createdAt: theses.createdAt })
    .from(watchlistItems).innerJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
    .where(eq(watchlistItems.userId, userId));
  return { theses: thesisRows, demo: process.env.THESIS_DATA_MODE === "demo" };
});
export type StoredThesis = Awaited<ReturnType<typeof getPresentationData>>["theses"][number];
export type HistoryPoint = { date: string; close: number };
/** Featured evidence is stored history, not restricted to the unread digest window. */
export async function getStoredEvidence(userId: number, symbol: string, currency: string | null = "INR") {
  const scope = and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol));
  const [verdicts, events] = await Promise.all([
    db.select({ evidence: thesisEvents.evidenceJson, occurredAt: thesisEvents.occurredAt }).from(watchlistItems)
      .innerJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
      .innerJoin(thesisEvents, eq(thesisEvents.thesisId, theses.id)).where(scope)
      .orderBy(desc(thesisEvents.occurredAt)).limit(1),
    db.select({ evidence: changeEvents.explainJson, occurredAt: changeEvents.occurredAt }).from(watchlistItems)
      .innerJoin(changeEvents, eq(changeEvents.symbol, watchlistItems.symbol)).where(scope)
      .orderBy(desc(changeEvents.occurredAt)).limit(1),
  ]);
  const stored = verdicts[0] ?? events[0];
  return { entries: stored ? evidenceFrom(stored.evidence as Record<string, unknown>, currency) : [], occurredAt: stored?.occurredAt ?? null };
}
export async function getStoredHistory(symbol: string): Promise<HistoryPoint[]> {
  const close = sql<string>`coalesce(${priceBars.currentProviderAdjClose}, ${priceBars.currentProviderClose})`;
  const bars = await db.select({ date: priceBars.tradingDate, close }).from(priceBars)
    .where(and(eq(priceBars.symbol, symbol), isNotNull(close), gt(close, "0"), gt(priceBars.currentProviderVolume, "0")))
    .orderBy(desc(priceBars.tradingDate)).limit(60);
  return bars.reverse().map((bar) => ({ date: bar.date, close: Number(bar.close) })).filter((bar) => Number.isFinite(bar.close));
}
