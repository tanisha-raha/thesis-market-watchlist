import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "@/db";
import {
  corporateActions, ingestionBatches, priceBars, quoteObservations, quotes, symbolStats,
} from "@/db/schema";
import { recordPollOutcome } from "@/lib/feed-health";
import { detectCorporateAction, isCandidate, type CorporateActionCandidate } from "@/lib/corporate-actions";
import { computeStats } from "@/lib/stats";
import { BENCHMARK } from "@/lib/universe";
import type { Bar, MarketDataProvider } from "@/lib/market/types";

/**
 * Ingestion.
 *
 * TRANSACTION DISCIPLINE, which is the whole point of this file's shape:
 *
 *   1. Network I/O happens BEFORE the transaction opens. Holding a Postgres
 *      transaction across a call to Yahoo would pin a connection for the length
 *      of an unpredictable remote request — expensive anywhere, worse on Neon
 *      where serverless pooling makes long transactions costly.
 *   2. The transaction covers the writes and nothing else, and EVERY write
 *      inside it uses the `tx` handle. A helper that closes over `db` issues its
 *      writes on a different connection and survives the rollback.
 *   3. The batch is marked COMPLETED only after the transaction commits. The
 *      digest cutoff is the completion timestamp of the last fully-committed
 *      batch, so COMPLETED must never be visible before the data it describes.
 */

const excluded = (column: string) => sql.raw(`excluded.${column}`);

const asNumeric = (n: number | null | undefined) => (n == null ? null : String(n));

export type BatchResult = { batchId: number; succeeded: number; missing: string[] };

/** Opens a batch row. Deliberately outside the write transaction so failures survive. */
async function openBatch(requestedCount: number) {
  const [batch] = await db
    .insert(ingestionBatches)
    .values({ status: "STARTED", requestedCount })
    .returning();
  return batch;
}

async function failBatch(batchId: number, error: unknown): Promise<void> {
  await db
    .update(ingestionBatches)
    .set({
      status: "FAILED",
      completedAt: new Date(),
      failureCount: 1,
      failureSummary: error instanceof Error ? error.message.slice(0, 500) : "unknown ingestion error",
    })
    .where(eq(ingestionBatches.id, batchId));
}

/* ------------------------------------------------------------------ quotes */

/**
 * Polls current quotes for a set of symbols and records the outcome.
 *
 * This is the only path the deployed app runs on a schedule.
 */
export async function ingestQuotes(
  provider: MarketDataProvider,
  requested: string[],
): Promise<BatchResult> {
  const batch = await openBatch(requested.length);

  try {
    // --- outside the transaction: the network call -------------------------
    const result = await provider.getQuotes(requested);
    const now = new Date();

    // --- inside the transaction: writes only, all on `tx` ------------------
    await db.transaction(async (tx) => {
      if (result.quotes.length > 0) {
        const rows = result.quotes.map((q) => ({
          batchId: batch.id,
          symbol: q.symbol,
          price: String(q.price),
          previousClose: asNumeric(q.previousClose),
          asOf: q.asOf,
          marketState: q.marketState,
          source: "poll" as const,
          fetchedAt: now,
        }));

        // Append-only price path. A repeated poll that returns the same exchange
        // timestamp is the same observation, not a new one.
        await tx.insert(quoteObservations).values(rows).onConflictDoNothing({
          target: [quoteObservations.symbol, quoteObservations.asOf, quoteObservations.source],
        });

        // Current-state projection, for rendering.
        await tx
          .insert(quotes)
          .values(rows.map(({ batchId: _b, source: _s, ...q }) => q))
          .onConflictDoUpdate({
            target: quotes.symbol,
            set: {
              price: excluded("price"),
              previousClose: excluded("previous_close"),
              asOf: excluded("as_of"),
              marketState: excluded("market_state"),
              fetchedAt: excluded("fetched_at"),
            },
          });
      }

      // `tx`, not `db` — see the transaction discipline note above.
      await recordPollOutcome(tx, result.quotes.map((q) => q.symbol), result.missing);
    });

    await db
      .update(ingestionBatches)
      .set({
        status: "COMPLETED",
        completedAt: new Date(),
        successCount: result.quotes.length,
        missingCount: result.missing.length,
      })
      .where(eq(ingestionBatches.id, batch.id));

    return { batchId: batch.id, succeeded: result.quotes.length, missing: result.missing };
  } catch (error) {
    await failBatch(batch.id, error);
    throw error;
  }
}

/* ----------------------------------------------------------------- history */

/**
 * Ingests daily bars for one symbol.
 *
 * Never runs in the deployed runtime. The brief forbids cold historical backfill
 * from the host: Yahoo throttles datacenter IPs harder than residential ones, so
 * history is fetched locally and shipped as a seed.
 */
export async function ingestHistory(
  provider: MarketDataProvider,
  symbol: string,
  sinceDays: number,
): Promise<{ batchId: number; bars: number }> {
  if (process.env.VERCEL) throw new Error("Historical backfill is disabled in deployed runtime.");

  const batch = await openBatch(1);
  try {
    const bars = await provider.getDailyBars(symbol, sinceDays);
    const now = new Date();

    await db.transaction(async (tx) => {
      if (bars.length === 0) return;
      await tx
        .insert(priceBars)
        .values(bars.map((b) => ({
          symbol,
          tradingDate: b.date,
          firstObservedClose: asNumeric(b.close),
          firstObservedVolume: asNumeric(b.volume),
          firstObservedAt: now,
          firstObservedBatchId: batch.id,
          currentProviderOpen: asNumeric(b.open),
          currentProviderClose: asNumeric(b.close),
          currentProviderAdjClose: asNumeric(b.adjClose),
          currentProviderVolume: asNumeric(b.volume),
          refreshedAt: now,
          refreshedBatchId: batch.id,
        })))
        // The first-observed columns are absent from this SET on purpose. They
        // are written once and never updated; that immutability is what lets us
        // detect that the provider restated its history.
        .onConflictDoUpdate({
          target: [priceBars.symbol, priceBars.tradingDate],
          set: {
            currentProviderOpen: excluded("current_provider_open"),
            currentProviderClose: excluded("current_provider_close"),
            currentProviderAdjClose: excluded("current_provider_adj_close"),
            currentProviderVolume: excluded("current_provider_volume"),
            refreshedAt: excluded("refreshed_at"),
            refreshedBatchId: excluded("refreshed_batch_id"),
          },
        });
    });

    await db
      .update(ingestionBatches)
      .set({ status: "COMPLETED", completedAt: new Date(), successCount: bars.length })
      .where(eq(ingestionBatches.id, batch.id));

    return { batchId: batch.id, bars: bars.length };
  } catch (error) {
    await failBatch(batch.id, error);
    throw error;
  }
}

/* ------------------------------------------------------------------- stats */

/** Reads stored bars back out as the `Bar` shape the pure stats functions expect. */
async function storedBars(executor: DbExecutor, symbol: string): Promise<Bar[]> {
  const rows = await executor
    .select({
      date: priceBars.tradingDate,
      close: priceBars.currentProviderClose,
      adjClose: priceBars.currentProviderAdjClose,
      volume: priceBars.currentProviderVolume,
    })
    .from(priceBars)
    .where(eq(priceBars.symbol, symbol))
    .orderBy(priceBars.tradingDate);

  return rows.map((r) => ({
    date: r.date,
    open: null,
    high: null,
    low: null,
    close: r.close == null ? null : Number(r.close),
    volume: r.volume == null ? null : Number(r.volume),
    adjClose: r.adjClose == null ? null : Number(r.adjClose),
  }));
}

/**
 * Recomputes `symbol_stats` for the given symbols from stored bars.
 *
 * Reads happen before the transaction; the transaction writes only.
 */
export async function refreshSymbolStats(symbols: string[]): Promise<{ batchId: number; updated: number }> {
  const batch = await openBatch(symbols.length);
  try {
    const benchmark = await storedBars(db, BENCHMARK);
    const computed: { symbol: string; stats: ReturnType<typeof computeStats> }[] = [];
    for (const symbol of symbols) {
      if (symbol === BENCHMARK) continue;
      const bars = await storedBars(db, symbol);
      if (bars.length === 0) continue;
      computed.push({ symbol, stats: computeStats(bars, benchmark) });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      for (const { symbol, stats } of computed) {
        await tx
          .insert(symbolStats)
          .values({
            symbol,
            batchId: batch.id,
            realizedVol20: asNumeric(stats.realizedVol20),
            medianVolume20: asNumeric(stats.medianVolume20),
            ma20: asNumeric(stats.ma20),
            beta60: asNumeric(stats.beta60),
            high52w: asNumeric(stats.high52w),
            low52w: asNumeric(stats.low52w),
            high20: asNumeric(stats.high20),
            low20: asNumeric(stats.low20),
            sessionsUsed: stats.sessionsUsed,
            computedAt: now,
          })
          .onConflictDoUpdate({
            target: symbolStats.symbol,
            set: {
              batchId: excluded("batch_id"),
              realizedVol20: excluded("realized_vol_20"),
              medianVolume20: excluded("median_volume_20"),
              ma20: excluded("ma_20"),
              beta60: excluded("beta_60"),
              high52w: excluded("high_52w"),
              low52w: excluded("low_52w"),
              high20: excluded("high_20"),
              low20: excluded("low_20"),
              sessionsUsed: excluded("sessions_used"),
              computedAt: excluded("computed_at"),
            },
          });
      }
    });

    await db
      .update(ingestionBatches)
      .set({ status: "COMPLETED", completedAt: new Date(), successCount: computed.length })
      .where(eq(ingestionBatches.id, batch.id));

    return { batchId: batch.id, updated: computed.length };
  } catch (error) {
    await failBatch(batch.id, error);
    throw error;
  }
}

/* ------------------------------------------------------- corporate actions */

/**
 * Detects provider-history restatements and records them.
 *
 * DETECTION ONLY. Adjusting the user's watermark price and their thesis
 * parameters is Phase 4 and is a must-land: detecting a split without adjusting
 * what the user typed is worse than not detecting it, because the stale
 * parameter then fires immediately and looks like a real trigger.
 */
export async function detectCorporateActions(
  symbols: string[],
): Promise<{ batchId: number; validated: number; rejected: number }> {
  const batch = await openBatch(symbols.length);
  try {
    const candidates: { symbol: string; candidate: CorporateActionCandidate }[] = [];

    for (const symbol of symbols) {
      const rows = await db
        .select({
          date: priceBars.tradingDate,
          first: priceBars.firstObservedClose,
          current: priceBars.currentProviderClose,
        })
        .from(priceBars)
        .where(eq(priceBars.symbol, symbol))
        .orderBy(priceBars.tradingDate);

      const values = rows
        .filter((r) => r.first != null && r.current != null)
        .map((r) => ({ date: r.date, first: Number(r.first), current: Number(r.current) }))
        // Only bars the provider has actually restated are evidence of anything.
        .filter((v) => Math.abs(v.current / v.first - 1) > 0.005);

      const result = detectCorporateAction(symbol, values);
      if (isCandidate(result)) candidates.push({ symbol, candidate: result });
    }

    const now = new Date();
    let validated = 0;
    let rejected = 0;

    await db.transaction(async (tx) => {
      for (const { symbol, candidate: c } of candidates) {
        if (c.status === "VALIDATED") validated++; else rejected++;
        await tx
          .insert(corporateActions)
          .values({
            fingerprint: c.fingerprint,
            symbol,
            candidateType: "split",
            factor: asNumeric(c.factor),
            affectedFrom: c.affectedFrom,
            affectedTo: c.affectedTo,
            supportingBars: c.supportingBars,
            status: c.status,
            reason: c.reason,
            batchId: batch.id,
            detectedAt: now,
          })
          // Idempotent: the same split detected on a later run is the same event.
          .onConflictDoNothing({ target: corporateActions.fingerprint });
      }
    });

    await db
      .update(ingestionBatches)
      .set({ status: "COMPLETED", completedAt: new Date(), successCount: validated + rejected })
      .where(eq(ingestionBatches.id, batch.id));

    return { batchId: batch.id, validated, rejected };
  } catch (error) {
    await failBatch(batch.id, error);
    throw error;
  }
}

/** Completion timestamp of the last fully-committed batch. The digest cutoff. */
export async function lastCommittedBatchAt(): Promise<Date | null> {
  const [row] = await db
    .select({ completedAt: ingestionBatches.completedAt })
    .from(ingestionBatches)
    .where(and(eq(ingestionBatches.status, "COMPLETED"), sql`${ingestionBatches.completedAt} is not null`))
    .orderBy(sql`${ingestionBatches.completedAt} desc`)
    .limit(1);
  return row?.completedAt ?? null;
}
