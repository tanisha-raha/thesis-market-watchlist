import { isTradedEquityBar } from "./market/calendar";
import type { Bar } from "./market/types";

/**
 * The thesis engine.
 *
 * A thesis is the user's stated reason for watching a symbol, expressed as a
 * structured type plus parameters. This module decides — deterministically, from
 * market data alone — whether that reason has been satisfied (TRIGGERED) or has
 * stopped holding (CONTRADICTED).
 *
 * No language model is consulted. A free-text note may accompany a thesis and is
 * shown back to the user verbatim, but it is never parsed and never influences a
 * verdict. Data decides.
 *
 * Three disciplines run through everything here:
 *
 *   CREATION FLOOR — a thesis is only ever evaluated against data from
 *   `createdAt` forward. If someone writes "interested below ₹2,800" today and
 *   the stock was there last week, we do not fire. The past is not evidence
 *   about a belief that did not exist yet.
 *
 *   MINIMUM OBSERVATION WINDOW — a thesis cannot be contradicted within 24h of
 *   creation or of its last acknowledgement. You cannot contradict a belief that
 *   is twenty minutes old.
 *
 *   TWO OF THREE — contradiction always requires at least two independent
 *   conditions. One noisy signal must never be able to tell someone their
 *   reasoning has failed.
 */

export type ThesisType =
  | "price_range"
  | "breakout"
  | "momentum_up"
  | "momentum_down"
  | "volatility_watch"
  | "volume_expansion"
  | "none";

export type ThesisParams = {
  low?: number;
  high?: number;
  level?: number;
  /** Snapshot of conditions when the thesis was written. Several rules are relative to it. */
  context?: {
    priceAtCreation?: number;
    realizedVolAtCreation?: number;
    gapAtCreation?: number;
  };
};

export type ThesisVerdictKind = "triggered" | "contradicted" | "still_valid";

export type ThesisVerdict = {
  kind: ThesisVerdictKind;
  occurredAt: Date;
  /** Which named conditions fired. Stored, so the evidence panel shows real reasoning. */
  conditionsMet: string[];
  evidence: Record<string, unknown>;
};

export type ThesisInput = {
  type: ThesisType;
  params: ThesisParams;
  createdAt: Date;
  lastAcknowledgedAt: Date | null;
  /** Verdicts already recorded, so cooldown and repetition can be respected. */
  priorEvents: { kind: string; occurredAt: Date }[];
  dailyBars: Bar[];
  benchmarkBars: Bar[];
  observations: { at: Date; price: number }[];
  /** |z| >= 2 anomalies from the change engine, for volatility_watch. */
  anomalies: { occurredAt: Date; magnitude: number; signalType: string }[];
  beta: number | null;
  /** Overridable so calibration can sweep the noise floor rather than guess it. */
  tuning?: { noiseFloorSigmas?: number };
};

/* ------------------------------------------------------------------ tuning */

const MIN_OBSERVATION_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A repeat inside the cooldown needs materially worse evidence: one more condition. */
const ESCALATION_CONDITIONS = 1;

/**
 * Consecutive sessions the contradiction conditions must hold before we say a
 * thesis has failed.
 *
 * Calibration forced this. Without it, "two of three" is satisfied by ordinary
 * fluctuation: any stock spends some day below its 20-day average with a
 * negative 20-day return, so momentum_up contradicted 96% of symbols inside two
 * months and breakout 96%. That is not a contradiction rule, it is a noise
 * detector with a confident vocabulary.
 *
 * The brief's principle is that one noisy signal must never be able to tell
 * someone their reasoning has failed. Requiring independent conditions applies
 * that across signals; requiring persistence applies the same idea across time.
 * A single day below a moving average is a wobble, not a change of thesis.
 */
const CONTRADICTION_PERSISTENCE_SESSIONS = 3;

/**
 * Noise floor for "negative" conditions, in units of the symbol's own 20-day
 * move (σ₂₀ = daily realized volatility × √20).
 *
 * Calibration forced this too. The brief asks for two of three INDEPENDENT
 * conditions, and taken literally the momentum conditions are not independent:
 * "20-day return negative" and "price below the 20-day average" are nearly the
 * same measurement, so two-of-three quietly collapsed to one-of-two and
 * momentum_up contradicted 92% of the symbols where it was plausible.
 *
 * A return that is negative by 0.1% is not evidence that someone's reasoning
 * failed, it is rounding. Requiring each condition to clear a fraction of a
 * typical 20-day move restores the independence the rule assumes. Expressed in
 * the symbol's own volatility rather than as a fixed percentage, so it means the
 * same thing for a utility and for a small-cap.
 */
const DEFAULT_NOISE_FLOOR_SIGMAS = 1.0;

/** Hairline crossings of a moving average are noise; use the same band as elsewhere. */
const MA_BAND = 0.005;

const VOL_CONTRADICTION_MULTIPLE = 2;      // realized vol above 2x its level at creation
const RESIDUAL_CONTRADICTION_PCT = -5;     // 20D benchmark-relative residual below -5%
const RANGE_ESCAPE_MULTIPLE = 1.5;         // price moved 1.5x the range gap away
const BREAKOUT_VOLUME_MULTIPLE = 1.5;      // breakout needs volume confirmation
const FAILED_BREAKOUT_PCT = -3;            // touched the level then closed 3% below
const VOLUME_EXPANSION_MULTIPLE = 2;
const VOLUME_EXPANSION_SESSIONS = 2;

/* ----------------------------------------------------------------- helpers */

const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const adj = (b: Bar) => {
  const v = b.adjClose ?? b.close;
  return finite(v) && v > 0 ? v : null;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Traded sessions only — a phantom holiday bar would poison every window. */
function sessions(bars: Bar[]): { date: string; close: number; volume: number | null; bar: Bar }[] {
  return bars
    .filter(isTradedEquityBar)
    .map((b) => ({ date: b.date, close: adj(b), volume: b.volume, bar: b }))
    .filter((s): s is { date: string; close: number; volume: number | null; bar: Bar } => s.close != null);
}

/** Sessions are dated; verdicts are instants. NSE closes at 15:30 IST = 10:00 UTC. */
const sessionInstant = (date: string) => new Date(`${date}T10:00:00.000Z`);

function movingAverage(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  return mean(closes.slice(-window));
}

function realizedVol(closes: number[], window = 20): number | null {
  const w = closes.slice(-(window + 1));
  if (w.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < w.length; i++) {
    if (w[i - 1] > 0 && w[i] > 0) {
      const r = Math.log(w[i] / w[i - 1]);
      if (Number.isFinite(r)) rets.push(r);
    }
  }
  if (rets.length < 2) return null;
  const m = mean(rets);
  const v = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1);
  return Number.isFinite(v) && v >= 0 ? Math.sqrt(v) : null;
}

/** Simple return over the last `days` sessions, as a percentage. */
function returnOver(closes: number[], days: number): number | null {
  if (closes.length < days + 1) return null;
  const from = closes[closes.length - 1 - days];
  const to = closes[closes.length - 1];
  return from > 0 ? (to / from - 1) * 100 : null;
}

/**
 * Benchmark-relative residual over `days`, as a percentage.
 *
 * If the market moved and the stock followed, that is not evidence about the
 * user's thesis — it is evidence about the market.
 */
function residualOver(
  symbolCloses: { date: string; close: number }[],
  benchByDate: Map<string, number>,
  beta: number | null,
  days: number,
): number | null {
  if (beta == null || symbolCloses.length < days + 1) return null;
  const slice = symbolCloses.slice(-(days + 1));
  const first = slice[0];
  const last = slice[slice.length - 1];
  const bFirst = benchByDate.get(first.date);
  const bLast = benchByDate.get(last.date);
  if (!finite(bFirst) || !finite(bLast) || bFirst <= 0 || first.close <= 0) return null;
  const rStock = (last.close / first.close - 1) * 100;
  const rIndex = (bLast / bFirst - 1) * 100;
  return rStock - beta * rIndex;
}

/* -------------------------------------------------------------- evaluation */

/** True when a contradiction is currently permitted for this thesis. */
function contradictionAllowedAt(at: Date, input: ThesisInput): boolean {
  const floor = Math.max(
    input.createdAt.getTime(),
    input.lastAcknowledgedAt?.getTime() ?? 0,
  );
  return at.getTime() - floor >= MIN_OBSERVATION_MS;
}

/** Cooldown: same kind within 24h needs materially worse evidence to fire again. */
function passesCooldown(
  at: Date,
  kind: ThesisVerdictKind,
  conditionCount: number,
  input: ThesisInput,
  lastFired: { at: Date; conditions: number } | null,
): boolean {
  const prior = lastFired
    ?? input.priorEvents
      .filter((e) => e.kind === kind)
      .map((e) => ({ at: e.occurredAt, conditions: 0 }))
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0]
    ?? null;
  if (!prior) return true;
  if (at.getTime() - prior.at.getTime() >= COOLDOWN_MS) return true;
  return conditionCount >= prior.conditions + ESCALATION_CONDITIONS;
}

type Condition = { name: string; met: boolean; detail: Record<string, unknown> };

/**
 * Evaluates one thesis over its whole life and returns the verdicts it produced.
 *
 * Returning a sequence rather than a single current answer is what makes the
 * engine testable and calibratable: the same function can be run across sixty
 * days of seeded history to measure how often each rule actually fires.
 */
export function evaluateThesis(input: ThesisInput): ThesisVerdict[] {
  if (input.type === "none") return [];

  const floor = input.createdAt.getTime();
  const all = sessions(input.dailyBars);
  // CREATION FLOOR. Data before the thesis existed is context for computing
  // windows, but nothing before it may ever produce a verdict.
  const evaluable = all.filter((s) => sessionInstant(s.date).getTime() >= floor);
  if (evaluable.length === 0 && input.type !== "volatility_watch") return [];

  const benchByDate = new Map<string, number>();
  for (const b of input.benchmarkBars) {
    const c = adj(b);
    if (c != null) benchByDate.set(b.date, c);
  }

  const verdicts: ThesisVerdict[] = [];
  let lastTrigger: { at: Date; conditions: number } | null = null;

  /* ---------------------------------------------------------- triggers ---- */

  const observations = input.observations
    .filter((o) => o.at.getTime() >= floor && finite(o.price) && o.price > 0)
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (input.type === "price_range" && finite(input.params.low) && finite(input.params.high)) {
    const { low, high } = input.params as { low: number; high: number };
    // First entry into the range after creation. Intraday, so a dip that is
    // bought back within the session still counts as the condition being met.
    const hit = observations.find((o) => o.price >= low && o.price <= high);
    if (hit) {
      verdicts.push({
        kind: "triggered",
        occurredAt: hit.at,
        conditionsMet: ["price_entered_range"],
        evidence: {
          thesis: "price_range",
          your_condition: `between ₹${low} and ₹${high}`,
          price: hit.price,
          range_low: low,
          range_high: high,
          entered_at: hit.at.toISOString(),
          evaluated_from: input.createdAt.toISOString(),
        },
      });
      lastTrigger = { at: hit.at, conditions: 1 };
    }
  }

  if (input.type === "breakout" && finite(input.params.level)) {
    const level = input.params.level;
    for (const s of evaluable) {
      // Volume confirmation is part of the trigger, not a nicety: a close above
      // a level on no volume is not the event the user was waiting for.
      const median = medianVolume(all, s.date, 20);
      if (!finite(median) || median <= 0 || !finite(s.volume)) continue;
      const ratio = s.volume / median;
      if (s.close > level && ratio >= BREAKOUT_VOLUME_MULTIPLE) {
        const at = sessionInstant(s.date);
        if (!passesCooldown(at, "triggered", 2, input, lastTrigger)) continue;
        verdicts.push({
          kind: "triggered",
          occurredAt: at,
          conditionsMet: ["closed_above_level", "volume_confirmed"],
          evidence: {
            thesis: "breakout",
            your_condition: `a breakout above ₹${level}`,
            trading_date: s.date,
            close: s.close,
            level,
            volume: s.volume,
            median_volume_20d: median,
            volume_vs_median: ratio,
            volume_confirmation_required: BREAKOUT_VOLUME_MULTIPLE,
          },
        });
        lastTrigger = { at, conditions: 2 };
        break;
      }
    }
  }

  if (input.type === "volatility_watch") {
    const hit = input.anomalies
      .filter((a) => a.occurredAt.getTime() >= floor && Math.abs(a.magnitude) >= 2)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0];
    if (hit) {
      verdicts.push({
        kind: "triggered",
        occurredAt: hit.occurredAt,
        conditionsMet: ["anomaly_z_at_or_above_2"],
        evidence: {
          thesis: "volatility_watch",
          your_condition: "any unusually large move",
          signal: hit.signalType,
          z_vs_20d_realized_vol: hit.magnitude,
          threshold_z: 2,
          occurred_at: hit.occurredAt.toISOString(),
        },
      });
    }
  }

  if (input.type === "volume_expansion") {
    for (let i = VOLUME_EXPANSION_SESSIONS - 1; i < evaluable.length; i++) {
      const window = evaluable.slice(i - VOLUME_EXPANSION_SESSIONS + 1, i + 1);
      const median = medianVolume(all, window[window.length - 1].date, 20);
      if (!finite(median) || median <= 0) continue;
      if (window.every((s) => finite(s.volume) && s.volume / median >= VOLUME_EXPANSION_MULTIPLE)) {
        const at = sessionInstant(window[window.length - 1].date);
        verdicts.push({
          kind: "triggered",
          occurredAt: at,
          conditionsMet: [`volume_at_or_above_${VOLUME_EXPANSION_MULTIPLE}x_for_${VOLUME_EXPANSION_SESSIONS}_sessions`],
          evidence: {
            thesis: "volume_expansion",
            your_condition: `volume at ${VOLUME_EXPANSION_MULTIPLE}x its median for ${VOLUME_EXPANSION_SESSIONS} sessions`,
            sessions: window.map((s) => ({ date: s.date, volume: s.volume, vs_median: s.volume! / median })),
            median_volume_20d: median,
          },
        });
        break;
      }
    }
  }

  /* ----------------------------------------------------- contradictions --- */

  // A contradiction is a STATE, not a recurring event: once a thesis is
  // contradicted it stays contradicted until the user acknowledges it, and
  // acknowledgement resets this whole evaluation. So we emit at most one, and
  // stop. Before this, daily sessions sat exactly 24h apart — precisely on the
  // cooldown boundary — so the cooldown never suppressed anything and a single
  // failing thesis produced twenty near-identical rows.
  let consecutive = 0;
  let firstOfRun: { at: Date; met: Condition[]; conditions: Condition[]; date: string; close: number } | null = null;

  for (const s of evaluable) {
    if (verdicts.some((v) => v.kind === "contradicted")) break;
    const at = sessionInstant(s.date);
    if (!contradictionAllowedAt(at, input)) continue;

    const upto = all.filter((x) => x.date <= s.date);
    const closes = upto.map((x) => x.close);
    const ma20 = movingAverage(closes, 20);
    const vol = realizedVol(closes, 20);
    const ret20 = returnOver(closes, 20);
    const residual20 = residualOver(upto, benchByDate, input.beta, 20);
    const residual10 = residualOver(upto, benchByDate, input.beta, 10);

    // A typical 20-day move for this symbol, as a percentage. Everything below
    // is compared against a fraction of it rather than against zero.
    const floorSigmas = input.tuning?.noiseFloorSigmas ?? DEFAULT_NOISE_FLOOR_SIGMAS;
    const sigma20Pct = finite(vol) ? vol * Math.sqrt(20) * 100 : null;
    const floorPct = finite(sigma20Pct) ? sigma20Pct * floorSigmas : 0;

    let conditions: Condition[] = [];

    if (input.type === "price_range" && finite(input.params.low) && finite(input.params.high)) {
      const { low, high } = input.params as { low: number; high: number };
      const gap = input.params.context?.gapAtCreation ?? Math.abs(high - low);
      const escaped = s.close > high
        ? s.close - high
        : s.close < low
          ? low - s.close
          : 0;
      const volAtCreation = input.params.context?.realizedVolAtCreation ?? null;
      conditions = [
        {
          name: "price_moved_away_from_range",
          met: gap > 0 && escaped > gap * RANGE_ESCAPE_MULTIPLE,
          detail: { close: s.close, range_low: low, range_high: high, distance_beyond_range: escaped, range_gap_at_creation: gap, threshold: gap * RANGE_ESCAPE_MULTIPLE },
        },
        {
          name: "volatility_doubled_since_creation",
          met: finite(vol) && finite(volAtCreation) && volAtCreation > 0 && vol > volAtCreation * VOL_CONTRADICTION_MULTIPLE,
          detail: { realized_vol_20d_now: vol, realized_vol_20d_at_creation: volAtCreation, multiple: VOL_CONTRADICTION_MULTIPLE },
        },
        {
          name: "benchmark_relative_residual_below_-5pct",
          met: finite(residual20) && residual20 < RESIDUAL_CONTRADICTION_PCT,
          detail: { residual_20d_pct: residual20, threshold_pct: RESIDUAL_CONTRADICTION_PCT, beta_60d: input.beta },
        },
      ];
    } else if (input.type === "breakout" && finite(input.params.level)) {
      const level = input.params.level;
      const touched = upto.some((x) => sessionInstant(x.date).getTime() >= floor && x.close >= level);
      conditions = [
        {
          name: "close_below_20d_ma",
          met: finite(ma20) && s.close < ma20 * (1 - MA_BAND),
          detail: { close: s.close, ma_20d: ma20, band_pct: MA_BAND * 100 },
        },
        {
          name: "failed_breakout",
          met: touched && s.close < level * (1 + FAILED_BREAKOUT_PCT / 100),
          detail: { close: s.close, level, touched_level_since_creation: touched, threshold: level * (1 + FAILED_BREAKOUT_PCT / 100) },
        },
        {
          name: "residual_negative_over_10d",
          met: finite(residual10) && residual10 < -floorPct,
          detail: { residual_10d_pct: residual10, noise_floor_pct: floorPct, beta_60d: input.beta },
        },
      ];
    } else if (input.type === "momentum_up" || input.type === "momentum_down") {
      const up = input.type === "momentum_up";
      conditions = [
        {
          name: up ? "price_below_20d_ma" : "price_above_20d_ma",
          met: finite(ma20) && (up ? s.close < ma20 * (1 - MA_BAND) : s.close > ma20 * (1 + MA_BAND)),
          detail: { close: s.close, ma_20d: ma20, band_pct: MA_BAND * 100 },
        },
        {
          name: up ? "20d_return_negative" : "20d_return_positive",
          met: finite(ret20) && (up ? ret20 < -floorPct : ret20 > floorPct),
          detail: { return_20d_pct: ret20, noise_floor_pct: floorPct, typical_20d_move_pct: sigma20Pct },
        },
        {
          name: up ? "residual_negative_over_20d" : "residual_positive_over_20d",
          met: finite(residual20) && (up ? residual20 < -floorPct : residual20 > floorPct),
          detail: { residual_20d_pct: residual20, noise_floor_pct: floorPct, beta_60d: input.beta },
        },
      ];
    } else if (input.type === "volume_expansion") {
      const last3 = upto.slice(-3);
      const median = medianVolume(all, s.date, 20);
      const priceThen = last3[0]?.close;
      conditions = [
        {
          name: "volume_below_median_for_3_sessions",
          met: last3.length === 3 && finite(median) && median > 0 && last3.every((x) => finite(x.volume) && x.volume < median),
          detail: { sessions: last3.map((x) => ({ date: x.date, volume: x.volume })), median_volume_20d: median },
        },
        {
          name: "price_unchanged_within_1pct",
          met: finite(priceThen) && priceThen > 0 && Math.abs(s.close / priceThen - 1) <= 0.01,
          detail: { close_now: s.close, close_3_sessions_ago: priceThen, change_pct: finite(priceThen) && priceThen > 0 ? (s.close / priceThen - 1) * 100 : null },
        },
      ];
    } else {
      continue;   // volatility_watch is a pure trigger thesis: no contradiction
    }

    const met = conditions.filter((c) => c.met);
    // TWO OF THREE. For volume_expansion the brief defines only two conditions,
    // so both are required — the principle is "more than one independent
    // signal", not the literal number three.
    const required = conditions.length >= 3 ? 2 : conditions.length;

    if (met.length < required) {
      consecutive = 0;
      firstOfRun = null;
      continue;
    }

    consecutive++;
    if (firstOfRun == null) firstOfRun = { at, met, conditions, date: s.date, close: s.close };
    if (consecutive < CONTRADICTION_PERSISTENCE_SESSIONS) continue;

    // The verdict is dated to the session the run STARTED, because that is when
    // the thesis actually stopped holding; the following sessions are what let
    // us be confident it was not a wobble.
    const run = firstOfRun;
    verdicts.push({
      kind: "contradicted",
      occurredAt: run.at,
      conditionsMet: run.met.map((c) => c.name),
      evidence: {
        thesis: input.type,
        trading_date: run.date,
        conditions_required: required,
        conditions_met: run.met.length,
        conditions: run.conditions.map((c) => ({ name: c.name, met: c.met, ...c.detail })),
        close: run.close,
        sustained_for_sessions: consecutive,
        persistence_required_sessions: CONTRADICTION_PERSISTENCE_SESSIONS,
        confirmed_on: s.date,
        evaluated_from: input.createdAt.toISOString(),
        minimum_observation_window_hours: MIN_OBSERVATION_MS / 3600000,
      },
    });
  }

  return verdicts.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** 20-session median volume as of a given date. */
function medianVolume(all: { date: string; volume: number | null }[], asOf: string, window: number): number | null {
  const vols = all
    .filter((s) => s.date <= asOf && finite(s.volume) && s.volume > 0)
    .slice(-window)
    .map((s) => s.volume!);
  if (vols.length === 0) return null;
  const sorted = [...vols].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * The state a thesis should be in, given its verdict history.
 *
 * A TRIGGERED thesis can subsequently be contradicted. A CONTRADICTED thesis
 * stays contradicted until the user acknowledges it. Acknowledgement resets to
 * WATCHING and restarts the observation window.
 */
export function resolveState(
  type: ThesisType,
  verdicts: ThesisVerdict[],
  lastAcknowledgedAt: Date | null,
): "WATCHING" | "TRIGGERED" | "CONTRADICTED" | "STILL_VALID" {
  const after = lastAcknowledgedAt
    ? verdicts.filter((v) => v.occurredAt.getTime() > lastAcknowledgedAt.getTime())
    : verdicts;
  if (after.some((v) => v.kind === "contradicted")) return "CONTRADICTED";
  if (after.some((v) => v.kind === "triggered")) return "TRIGGERED";
  // Maintenance theses assert an ongoing state, so surviving is itself the news.
  if (type === "momentum_up" || type === "momentum_down") return "STILL_VALID";
  return "WATCHING";
}
