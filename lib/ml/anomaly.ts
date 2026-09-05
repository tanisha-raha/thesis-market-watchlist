import { DEFAULT_FOREST, anomalyScore, fitIsolationForest, quantile, type IsolationForestConfig } from "./isolation-forest";
import { buildFeatureRows, toMatrix, type FeatureName } from "./features";
import type { Bar } from "../market/types";

/**
 * The anomaly layer: is this security's CURRENT combination of market behaviour
 * unusual compared with its OWN recent history?
 *
 * Secondary evidence, always. The deterministic engine decides what happened and
 * whether a user's condition was met; this only ever adds context, and the
 * product is complete without it.
 *
 * WHAT IT IS NOT. It does not forecast, rank, recommend or score a security for
 * investment. It answers one question about the past — "does today look like the
 * last year of days?" — and its output is categorical for exactly that reason.
 *
 * WHY UNSUPERVISED. There is no ground truth for whether a market observation
 * "matters" to a given investor, so there is nothing honest to train a supervised
 * classifier against. Isolation Forest needs no labels: it learns the shape of
 * this security's ordinary behaviour and reports how easily today separates from
 * it.
 *
 * PER SECURITY, NEVER POOLED. A model fitted across many securities would need
 * cross-sectional normalisation to be meaningful, and "unusual" would then mean
 * "unlike other companies" rather than "unlike itself". Each security is fitted
 * against its own history, which is also what makes the features comparable
 * without any scaling.
 */

/** Bump when features, thresholds or model configuration change. Stored on every row. */
export const MODEL_VERSION = "iforest-2026-09-a";

/**
 * Fitting window and the floor below which we decline to answer.
 *
 * 60 rows is roughly a quarter of trading sessions: enough for the forest's
 * sub-sampling to see the ordinary range of behaviour, and few enough that a
 * newly seeded security becomes eligible within a season. Below it the honest
 * answer is INSUFFICIENT_HISTORY, not a confident one from thin data.
 */
export const MIN_TRAINING_ROWS = 60;
export const TRAINING_WINDOW = 250;

/**
 * How unusual a day has to be, expressed in the security's own terms.
 *
 * The threshold is the 99th percentile of the training scores — the model's own
 * distribution for this security — rather than a hardcoded constant that would
 * mean different things for a utility and a small cap. A day is UNUSUAL only if
 * it scores strictly above the level that all but ~1% of its own recent history
 * scored below.
 */
export const THRESHOLD_QUANTILE = 0.99;

export type AnomalyStatus = "UNUSUAL" | "NORMAL" | "INSUFFICIENT_HISTORY" | "UNAVAILABLE";

export type AnomalyEvaluation = {
  status: AnomalyStatus;
  /** The evaluated trading date, or null when nothing could be evaluated. */
  date: string | null;
  /** Raw model output in [0,1). Stored for reproducibility; never rendered as a score. */
  score: number | null;
  threshold: number | null;
  modelVersion: string;
  /** The exact inputs the model saw, in real units. Rendered as evidence, not attribution. */
  features: Partial<Record<FeatureName, number>>;
  columns: FeatureName[];
  window: {
    trainingRows: number;
    from: string | null;
    through: string | null;
    droppedRows: number;
    minimumRows: number;
  };
  config: IsolationForestConfig & { thresholdQuantile: number };
  /** Why an evaluation could not be produced. Present only for the two non-results. */
  reason?: string;
};

function unavailable(status: AnomalyStatus, reason: string, partial: Partial<AnomalyEvaluation> = {}): AnomalyEvaluation {
  return {
    status, date: null, score: null, threshold: null, modelVersion: MODEL_VERSION,
    features: {}, columns: [],
    window: { trainingRows: 0, from: null, through: null, droppedRows: 0, minimumRows: MIN_TRAINING_ROWS },
    config: { ...DEFAULT_FOREST, thresholdQuantile: THRESHOLD_QUANTILE },
    reason,
    ...partial,
  };
}

/**
 * Evaluates the most recent session (or `asOfDate`) against everything before it.
 *
 * NO FUTURE DATA, BY CONSTRUCTION. The series is truncated at the evaluated date,
 * the forest is fitted on rows STRICTLY BEFORE that date, and the threshold comes
 * from those same rows' scores. Evaluating an old date therefore returns the same
 * answer today as it would have on the day — which is what makes stored anomaly
 * evidence auditable rather than merely re-derivable.
 */
export function evaluateAnomaly(input: {
  bars: Bar[];
  benchmarkBars?: Bar[];
  /** Evaluate this trading date rather than the latest one. */
  asOfDate?: string;
  config?: IsolationForestConfig;
}): AnomalyEvaluation {
  const config = input.config ?? DEFAULT_FOREST;
  try {
    const rows = buildFeatureRows(input.bars, input.benchmarkBars ?? [], input.asOfDate);
    if (rows.length === 0) return unavailable("INSUFFICIENT_HISTORY", "no usable traded sessions");

    const target = rows[rows.length - 1];
    if (input.asOfDate && target.date !== input.asOfDate) {
      return unavailable("INSUFFICIENT_HISTORY", `no traded session on ${input.asOfDate}`);
    }

    // Fit on history only. The evaluated row is never part of its own training set.
    const history = rows.slice(0, -1).slice(-TRAINING_WINDOW);
    const matrix = toMatrix(history, target);
    if (matrix.columns.length < 3) {
      return unavailable("INSUFFICIENT_HISTORY", "fewer than three features are available for this security", {
        date: target.date,
        window: { trainingRows: matrix.rows.length, from: null, through: null, droppedRows: matrix.dropped, minimumRows: MIN_TRAINING_ROWS },
      });
    }
    if (matrix.rows.length < MIN_TRAINING_ROWS) {
      return unavailable("INSUFFICIENT_HISTORY", `${matrix.rows.length} usable training rows, ${MIN_TRAINING_ROWS} required`, {
        date: target.date,
        columns: matrix.columns,
        window: {
          trainingRows: matrix.rows.length, droppedRows: matrix.dropped, minimumRows: MIN_TRAINING_ROWS,
          from: matrix.rows[0]?.date ?? null, through: matrix.rows.at(-1)?.date ?? null,
        },
      });
    }

    const point = matrix.columns.map((name) => target.values[name]!);
    if (point.some((v) => v == null || !Number.isFinite(v))) {
      return unavailable("UNAVAILABLE", "the evaluated session is missing a fitted feature", { date: target.date, columns: matrix.columns });
    }

    const forest = fitIsolationForest(matrix.rows.map((row) => row.vector), config);
    const trainingScores = matrix.rows.map((row) => anomalyScore(forest, row.vector));
    const threshold = quantile(trainingScores, THRESHOLD_QUANTILE);
    const score = anomalyScore(forest, point);
    if (threshold == null || !Number.isFinite(score)) {
      return unavailable("UNAVAILABLE", "the model produced no usable score", { date: target.date, columns: matrix.columns });
    }

    const features: Partial<Record<FeatureName, number>> = {};
    for (const name of matrix.columns) features[name] = target.values[name];

    return {
      status: score > threshold ? "UNUSUAL" : "NORMAL",
      date: target.date,
      score,
      threshold,
      modelVersion: MODEL_VERSION,
      features,
      columns: matrix.columns,
      window: {
        trainingRows: matrix.rows.length,
        from: matrix.rows[0].date,
        through: matrix.rows.at(-1)!.date,
        droppedRows: matrix.dropped,
        minimumRows: MIN_TRAINING_ROWS,
      },
      config: { ...config, thresholdQuantile: THRESHOLD_QUANTILE },
    };
  } catch (error) {
    // A model failure is a missing opinion, never a broken page and never a
    // fabricated result. The deterministic engine is unaffected either way.
    return unavailable("UNAVAILABLE", error instanceof Error ? error.message.slice(0, 200) : "anomaly evaluation failed");
  }
}

/** Human-readable units for the evidence rows. Presentation only; never causal. */
export const FEATURE_LABELS: Record<FeatureName, { label: string; format: (value: number) => string; basis?: string }> = {
  daily_return: { label: "Price move", format: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`, basis: "vs previous close" },
  standardized_return: { label: "Standardized move", format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}σ`, basis: "vs 20-day realized volatility" },
  realized_volatility: { label: "Realized volatility", format: (v) => `${(v * 100).toFixed(2)}%`, basis: "daily, 20-day, before this session" },
  log_relative_volume: { label: "Relative volume", format: (v) => `${Math.exp(v).toFixed(1)}×`, basis: "of 20-day median" },
  benchmark_residual: { label: "Benchmark-relative residual", format: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`, basis: "beta-adjusted" },
  distance_from_ma20: { label: "Distance from 20-day average", format: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%` },
  range_position: { label: "Position in 20-day range", format: (v) => `${(v * 100).toFixed(0)}%`, basis: "0% at the low, 100% at the high" },
  gap_return: { label: "Gap from previous close", format: (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`, basis: "unadjusted open vs close" },
};

/** The stored feature snapshot, rendered in real units for display. */
export function anomalyEvidence(features: Partial<Record<FeatureName, number>>) {
  return (Object.keys(FEATURE_LABELS) as FeatureName[]).flatMap((name) => {
    const value = features[name];
    if (value == null || !Number.isFinite(value)) return [];
    const spec = FEATURE_LABELS[name];
    return [{ label: spec.label, value: spec.format(value), basis: spec.basis }];
  });
}
