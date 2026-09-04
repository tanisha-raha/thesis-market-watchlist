import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, ingestionBatches, priceBars, quoteObservations, symbolStats } from "@/db/schema";
import { detectEvents, type DetectedEvent, type Observation } from "@/lib/change-engine";
import { BENCHMARK } from "@/lib/universe";
import type { Bar } from "@/lib/market/types";
import type { SymbolStats } from "@/lib/stats";

/**
 * Persistence for the change engine.
 *
 * Detection itself is pure and lives in lib/change-engine.ts. This file does the
 * reading and writing, and enforces one rule the engine cannot enforce on its
 * own: an event, once recorded, is never rewritten. `occurredAt`, `magnitude`
 * and `explainJson` are written once. `resolvedAt` may transition from null to a
 * timestamp exactly once and can never be cleared or moved.
 *
 * That is not fussiness. `explainJson` is the evidence a user is shown, and a
 * value that drifted after the fact would be evidence for a claim we are no
 * longer making. `resolvedAt` is what makes a missed event a missed event.
 */

async function loadBars(symbol: string): Promise<Bar[]> {
  const rows = await db
    .select({
      date: priceBars.tradingDate,
      open: priceBars.currentProviderOpen,
      close: priceBars.currentProviderClose,
      adjClose: priceBars.currentProviderAdjClose,
      volume: priceBars.currentProviderVolume,
    })
    .from(priceBars)
    .where(eq(priceBars.symbol, symbol))
    .orderBy(asc(priceBars.tradingDate));

  return rows.map((r) => ({
    date: r.date,
    open: r.open == null ? null : Number(r.open),
    high: null,
    low: null,
    close: r.close == null ? null : Number(r.close),
    volume: r.volume == null ? null : Number(r.volume),
    adjClose: r.adjClose == null ? null : Number(r.adjClose),
  }));
}

/**
 * The intraday price path — live polls and seeded 5-minute closes, as one
 * ordered series. Resolution of transient events is evaluated against this and
 * never against daily bars; on daily bars a move that reverses inside the
 * session leaves no trace at all and the feature would silently never fire.
 */
async function loadObservations(symbol: string): Promise<Observation[]> {
  const rows = await db
    .select({ at: quoteObservations.asOf, price: quoteObservations.price })
    .from(quoteObservations)
    .where(eq(quoteObservations.symbol, symbol))
    .orderBy(asc(quoteObservations.asOf));
  return rows.map((r) => ({ at: r.at, price: Number(r.price) }));
}

async function loadStats(symbol: string): Promise<SymbolStats | null> {
  const [row] = await db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1);
  if (!row) return null;
  const n = (v: string | null) => (v == null ? null : Number(v));
  return {
    realizedVol20: n(row.realizedVol20),
    medianVolume20: n(row.medianVolume20),
    ma20: n(row.ma20),
    beta60: n(row.beta60),
    high52w: n(row.high52w),
    low52w: n(row.low52w),
    high20: n(row.high20),
    low20: n(row.low20),
    sessionsUsed: row.sessionsUsed,
  };
}

export type DetectionSummary = {
  batchId: number;
  symbolsProcessed: number;
  inserted: number;
  resolved: number;
  stillOpen: number;
};

/**
 * Runs detection for the given symbols and persists the result.
 *
 * Reads happen outside the transaction; the transaction covers writes only.
 */
/**
 * How far back detection looks by default.
 *
 * Deliberately matched to the intraday history we hold. `symbol_stats` describes
 * a symbol as it is NOW — today's realized volatility, today's 52-week levels —
 * and applying those to bars from two years ago produces confident nonsense: a
 * 2024 session scored against 2026 volatility read as an 8-sigma gap. We only
 * claim events for the period our statistics can honestly describe.
 */
export const DETECTION_WINDOW_DAYS = 60;

export async function runDetection(
  symbols: string[],
  options: { sinceDays?: number } = {},
): Promise<DetectionSummary> {
  const since = new Date(Date.now() - (options.sinceDays ?? DETECTION_WINDOW_DAYS) * 864e5);
  const [batch] = await db
    .insert(ingestionBatches)
    .values({ status: "STARTED", requestedCount: symbols.length, failureSummary: "detection" })
    .returning();

  try {
    const benchmarkBars = await loadBars(BENCHMARK);
    const perSymbol: { symbol: string; events: DetectedEvent[] }[] = [];

    for (const symbol of symbols) {
      if (symbol === BENCHMARK) continue;
      const stats = await loadStats(symbol);
      if (!stats) continue;                       // no stats yet: nothing to normalize against
      const [dailyBars, observations] = await Promise.all([loadBars(symbol), loadObservations(symbol)]);
      if (dailyBars.length === 0 && observations.length === 0) continue;
      perSymbol.push({
        symbol,
        events: detectEvents({ symbol, stats, observations, dailyBars, benchmarkBars, since }),
      });
    }

    const detectedAt = new Date();
    let inserted = 0;
    let resolved = 0;

    await db.transaction(async (tx) => {
      for (const { symbol, events } of perSymbol) {
        for (const e of events) {
          const [row] = await tx
            .insert(changeEvents)
            .values({
              symbol,
              signalType: e.signalType,
              window: e.window,
              magnitude: String(e.magnitude),
              score: String(e.score),
              occurredAt: e.occurredAt,
              resolvedAt: e.resolvedAt,
              detectedAt,
              ingestionBatchId: batch.id,
              explainJson: e.explain,
            })
            .onConflictDoUpdate({
              target: [changeEvents.symbol, changeEvents.signalType, changeEvents.occurredAt],
              // The ONLY mutable field, and only ever null -> value. COALESCE keeps
              // the first resolution we recorded and makes clearing it impossible;
              // magnitude, score and explain_json are deliberately absent here.
              set: { resolvedAt: sql`coalesce(${changeEvents.resolvedAt}, excluded.resolved_at)` },
              setWhere: isNull(changeEvents.resolvedAt),
            })
            .returning({ id: changeEvents.id, resolvedAt: changeEvents.resolvedAt, detectedAt: changeEvents.detectedAt });

          if (row?.detectedAt.getTime() === detectedAt.getTime()) inserted++;
          else if (row?.resolvedAt != null) resolved++;
        }
      }
    });

    const [{ open }] = await db
      .select({ open: sql<number>`count(*)::int` })
      .from(changeEvents)
      .where(isNull(changeEvents.resolvedAt));

    await db
      .update(ingestionBatches)
      .set({ status: "COMPLETED", completedAt: new Date(), successCount: inserted })
      .where(eq(ingestionBatches.id, batch.id));

    return { batchId: batch.id, symbolsProcessed: perSymbol.length, inserted, resolved, stillOpen: open };
  } catch (error) {
    await db
      .update(ingestionBatches)
      .set({
        status: "FAILED",
        completedAt: new Date(),
        failureCount: 1,
        failureSummary: error instanceof Error ? error.message.slice(0, 500) : "detection failed",
      })
      .where(eq(ingestionBatches.id, batch.id));
    throw error;
  }
}

/**
 * Events that fired AND reversed entirely within a window — the missed events.
 *
 * Expressed as a query rather than as a filter in application code because the
 * digest needs it per user, per symbol, against a watermark.
 */
export async function missedEventsBetween(symbol: string, from: Date, until: Date) {
  return db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.symbol, symbol),
        sql`${changeEvents.occurredAt} >= ${from}`,
        sql`${changeEvents.resolvedAt} is not null`,
        sql`${changeEvents.resolvedAt} <= ${until}`,
      ),
    )
    .orderBy(asc(changeEvents.occurredAt));
}
