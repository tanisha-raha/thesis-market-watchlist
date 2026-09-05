import "server-only";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import { ingestionBatches, marketAnomalies, priceBars } from "@/db/schema";
import { loadSecurities } from "@/lib/securities-server";
import { REGIONS, isBenchmarkSymbol } from "@/lib/securities";
import { zonedInstant } from "@/lib/time";
import { MODEL_VERSION, evaluateAnomaly } from "@/lib/ml/anomaly";
import type { FeatureName } from "@/lib/ml/features";
import type { Bar } from "@/lib/market/types";

/**
 * Persistence for the anomaly layer.
 *
 * WHERE IT RUNS. Once per symbol, inside the scheduled ingestion run, after
 * deterministic detection has already committed. Cost is O(unique symbols) —
 * about 20ms per security to fit and score — and nothing about it is per user;
 * personalisation happens later, in the thesis layer, exactly as it does for
 * change events.
 *
 * WHAT FAILURE MEANS. Every symbol is evaluated inside its own try/catch and the
 * caller wraps the whole run again: a model failure records nothing and changes
 * nothing. Detection, theses, the digest and the watchlist have already done
 * their work by the time this runs, and none of them read this table.
 *
 * LIVE AND DEMO NEVER MIX. Every row is stamped with the data mode it was
 * produced under, that mode is part of the identity index, and reads filter on
 * it. A demo replay cannot overwrite live evidence or be shown as live.
 */

export type DataMode = "live" | "demo";

export function currentDataMode(): DataMode {
  return process.env.THESIS_DATA_MODE === "demo" ? "demo" : "live";
}

export type AnomalySummary = {
  batchId: number | null;
  evaluated: number;
  unusual: number;
  insufficient: number;
  failed: number;
  skipped: number;
};

async function loadBars(symbol: string): Promise<Bar[]> {
  const rows = await db
    .select({
      date: priceBars.tradingDate,
      open: priceBars.currentProviderOpen,
      close: priceBars.currentProviderClose,
      adjClose: priceBars.currentProviderAdjClose,
      volume: priceBars.currentProviderVolume,
    })
    .from(priceBars).where(eq(priceBars.symbol, symbol)).orderBy(asc(priceBars.tradingDate));
  const num = (v: string | null) => (v == null ? null : Number(v));
  return rows.map((r) => ({
    date: r.date, high: null, low: null,
    open: num(r.open), close: num(r.close), adjClose: num(r.adjClose), volume: num(r.volume),
  }));
}

/**
 * Evaluates the latest session for each symbol and records the result.
 *
 * Skips a symbol whose latest session already has a row for this model version
 * and data mode, so the ten-minute poll fits each security once per session
 * rather than once per poll.
 */
export async function runAnomalyDetection(
  symbolList: string[],
  options: { dataMode?: DataMode } = {},
): Promise<AnomalySummary> {
  const dataMode = options.dataMode ?? currentDataMode();
  const targets = [...new Set(symbolList)].filter((symbol) => !isBenchmarkSymbol(symbol));
  const summary: AnomalySummary = { batchId: null, evaluated: 0, unusual: 0, insufficient: 0, failed: 0, skipped: 0 };
  if (targets.length === 0) return summary;

  const [batch] = await db.insert(ingestionBatches)
    .values({ status: "STARTED", requestedCount: targets.length, failureSummary: "anomaly" })
    .returning();
  summary.batchId = batch.id;

  try {
    const securities = await loadSecurities(targets);
    const benchmarks = new Map<string, Bar[]>();
    for (const benchmark of new Set([...securities.values()].map((s) => s.benchmark).filter((b): b is string => b != null))) {
      benchmarks.set(benchmark, await loadBars(benchmark));
    }

    const existing = await db
      .select({ symbol: marketAnomalies.symbol, tradingDate: marketAnomalies.tradingDate })
      .from(marketAnomalies)
      .where(and(
        inArray(marketAnomalies.symbol, targets),
        eq(marketAnomalies.modelVersion, MODEL_VERSION),
        eq(marketAnomalies.dataMode, dataMode),
        // Only recent rows matter for the skip check.
        gte(marketAnomalies.evaluatedAt, new Date(Date.now() - 30 * 864e5)),
      ));
    const evaluatedDates = new Set(existing.map((row) => `${row.symbol}|${row.tradingDate}`));

    const evaluatedAt = new Date();
    for (const symbol of targets) {
      try {
        const security = securities.get(symbol)!;
        const bars = await loadBars(symbol);
        if (bars.length === 0) { summary.skipped++; continue; }

        const latest = bars.filter((b) => b.close != null && b.volume != null && b.volume > 0).at(-1);
        if (!latest) { summary.skipped++; continue; }
        if (evaluatedDates.has(`${symbol}|${latest.date}`)) { summary.skipped++; continue; }

        const result = evaluateAnomaly({
          bars,
          benchmarkBars: security.benchmark ? benchmarks.get(security.benchmark) ?? [] : [],
        });
        if (result.status === "INSUFFICIENT_HISTORY") { summary.insufficient++; continue; }
        if (result.status === "UNAVAILABLE" || result.date == null) { summary.failed++; continue; }

        const region = security.region ? REGIONS[security.region] : REGIONS.IN;
        await db.insert(marketAnomalies).values({
          symbol,
          tradingDate: result.date,
          // The session's close on that exchange's own clock, so an anomaly lines
          // up with the change events recorded for the same session.
          occurredAt: zonedInstant(result.date, security.timeZone, ...region.sessionClose),
          status: result.status,
          score: result.score == null ? null : String(result.score),
          threshold: result.threshold == null ? null : String(result.threshold),
          modelVersion: result.modelVersion,
          dataMode,
          featuresJson: result.features,
          windowJson: { ...result.window, columns: result.columns, config: result.config, benchmark: security.benchmark },
          evaluatedAt,
          batchId: batch.id,
        }).onConflictDoNothing({
          target: [marketAnomalies.symbol, marketAnomalies.tradingDate, marketAnomalies.modelVersion, marketAnomalies.dataMode],
        });

        summary.evaluated++;
        if (result.status === "UNUSUAL") summary.unusual++;
      } catch {
        // One security's model failure is not the run's failure.
        summary.failed++;
      }
    }

    await db.update(ingestionBatches)
      .set({ status: "COMPLETED", completedAt: new Date(), successCount: summary.evaluated, failureCount: summary.failed })
      .where(eq(ingestionBatches.id, batch.id));
    return summary;
  } catch (error) {
    await db.update(ingestionBatches)
      .set({
        status: "FAILED", completedAt: new Date(), failureCount: 1,
        failureSummary: error instanceof Error ? error.message.slice(0, 500) : "anomaly detection failed",
      })
      .where(eq(ingestionBatches.id, batch.id));
    throw error;
  }
}

export type StoredAnomaly = {
  symbol: string;
  tradingDate: string;
  /** Which world this evaluation came from. Live and demo never mix. */
  dataMode: DataMode;
  occurredAt: Date;
  status: "UNUSUAL" | "NORMAL";
  score: number | null;
  threshold: number | null;
  modelVersion: string;
  features: Partial<Record<FeatureName, number>>;
  window: Record<string, unknown>;
  evaluatedAt: Date;
};

function toStored(row: typeof marketAnomalies.$inferSelect): StoredAnomaly {
  return {
    symbol: row.symbol,
    tradingDate: row.tradingDate,
    dataMode: row.dataMode === "demo" ? "demo" : "live",
    occurredAt: row.occurredAt,
    status: row.status === "UNUSUAL" ? "UNUSUAL" : "NORMAL",
    score: row.score == null ? null : Number(row.score),
    threshold: row.threshold == null ? null : Number(row.threshold),
    modelVersion: row.modelVersion,
    features: (row.featuresJson ?? {}) as Partial<Record<FeatureName, number>>,
    window: (row.windowJson ?? {}) as Record<string, unknown>,
    evaluatedAt: row.evaluatedAt,
  };
}

/**
 * The most recent stored evaluation for one security, in the current data mode.
 *
 * A read, never a computation: the page renders the evidence recorded at
 * detection time rather than re-fitting a model on every request.
 */
export async function getLatestAnomaly(symbol: string, dataMode: DataMode = currentDataMode()): Promise<StoredAnomaly | null> {
  const [row] = await db.select().from(marketAnomalies)
    .where(and(eq(marketAnomalies.symbol, symbol), eq(marketAnomalies.dataMode, dataMode)))
    .orderBy(desc(marketAnomalies.tradingDate)).limit(1);
  return row ? toStored(row) : null;
}

/** Unusual sessions for a set of symbols since a given date. Used to badge digest cards. */
export async function getUnusualSessions(
  symbolList: string[],
  since: string,
  dataMode: DataMode = currentDataMode(),
): Promise<Map<string, StoredAnomaly>> {
  const found = new Map<string, StoredAnomaly>();
  const symbols_ = [...new Set(symbolList)];
  if (symbols_.length === 0) return found;
  const rows = await db.select().from(marketAnomalies)
    .where(and(
      inArray(marketAnomalies.symbol, symbols_),
      eq(marketAnomalies.dataMode, dataMode),
      eq(marketAnomalies.status, "UNUSUAL"),
      gte(marketAnomalies.tradingDate, since),
    ));
  // Keyed by symbol AND session: an anomaly badges the event from the same day,
  // never a different one.
  for (const row of rows) found.set(`${row.symbol}|${row.tradingDate}`, toStored(row));
  return found;
}
