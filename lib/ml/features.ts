import { alignSeries, isTradedEquityBar } from "../market/calendar";
import type { Bar } from "../market/types";

/**
 * The feature pipeline behind the anomaly model.
 *
 * Deterministic, pure, and built from the same series the deterministic engine
 * already reasons about — no new data source, no fabricated observation.
 *
 * TWO RULES RUN THROUGH EVERY FEATURE:
 *
 *   ONLY THE PAST. Every rolling input for session i — volatility, median volume,
 *   the moving average, the 20-day range, beta — is computed from sessions BEFORE
 *   i. The only value of session i that enters its own row is what actually
 *   happened that day: its close, its open and its volume. A feature that used
 *   session i's own volatility window would be telling the model the answer.
 *
 *   MISSING IS MISSING. A feature that cannot be computed is `null`, never 0.
 *   Zero is a legitimate value for a return and for a distance from a moving
 *   average, so imputing it would put a fabricated "flat day" into the training
 *   set. Columns that are unavailable for a security are dropped for that
 *   security entirely, and rows missing a kept column are excluded.
 *
 * TRADED SESSIONS ONLY, ADJUSTED SERIES — the same discipline as lib/stats.ts.
 * A phantom holiday bar carries a stale close and zero volume, and would read as
 * a total volume collapse.
 */

export const FEATURE_NAMES = [
  "daily_return",
  "standardized_return",
  "realized_volatility",
  "log_relative_volume",
  "benchmark_residual",
  "distance_from_ma20",
  "range_position",
  "gap_return",
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];

export type FeatureRow = {
  /** Exchange-local trading date of the session this row describes. */
  date: string;
  values: Partial<Record<FeatureName, number>>;
};

export type FeatureMatrix = {
  /** Columns kept for this security, in a fixed order. */
  columns: FeatureName[];
  /** Rows with every kept column present, oldest first. */
  rows: { date: string; vector: number[]; values: Partial<Record<FeatureName, number>> }[];
  /** Rows that had a usable session but were dropped for a missing kept column. */
  dropped: number;
};

/** Sessions of history each rolling input needs before it can be computed. */
const VOL_WINDOW = 20;
const VOLUME_WINDOW = 20;
const MA_WINDOW = 20;
const RANGE_WINDOW = 20;
const BETA_WINDOW = 60;

/** A column is kept only if the security actually has it for most of its history. */
const COLUMN_COVERAGE = 0.9;

const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const adjusted = (bar: Bar): number | null => {
  const v = bar.adjClose ?? bar.close;
  return finite(v) && v > 0 ? v : null;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Number.isFinite(v) && v > 0 ? Math.sqrt(v) : null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const value = s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  return Number.isFinite(value) ? value : null;
}

/** Guards every derived value: an infinity or NaN is missing data, not a number. */
const usable = (value: number | null | undefined): number | null =>
  value != null && Number.isFinite(value) ? value : null;

type Session = { date: string; close: number; open: number | null; rawClose: number | null; volume: number };

function sessionsOf(bars: Bar[]): Session[] {
  const seen = new Set<string>();
  return bars
    .filter((bar) => isTradedEquityBar(bar) && adjusted(bar) != null)
    // A provider restatement can re-emit a date; the first one wins so the series
    // stays a function of the trading date.
    .filter((bar) => (seen.has(bar.date) ? false : (seen.add(bar.date), true)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((bar) => ({
      date: bar.date,
      close: adjusted(bar)!,
      open: finite(bar.open) && bar.open > 0 ? bar.open : null,
      rawClose: finite(bar.close) && bar.close > 0 ? bar.close : null,
      volume: bar.volume!,
    }));
}

/**
 * Rolling beta against the benchmark, from sessions strictly before `date`.
 *
 * Computed on the aligned pairs so a benchmark holiday cannot silently produce a
 * NaN — the same alignment the deterministic statistics use.
 */
function trailingBeta(pairs: { date: string; a: number; b: number }[], upto: number): number | null {
  const window = pairs.slice(Math.max(0, upto - BETA_WINDOW), upto);
  if (window.length < 10) return null;
  const sr: number[] = [];
  const br: number[] = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1].a <= 0 || window[i].a <= 0 || window[i - 1].b <= 0 || window[i].b <= 0) continue;
    const s = Math.log(window[i].a / window[i - 1].a);
    const b = Math.log(window[i].b / window[i - 1].b);
    if (Number.isFinite(s) && Number.isFinite(b)) { sr.push(s); br.push(b); }
  }
  if (sr.length < 5) return null;
  const sm = mean(sr);
  const bm = mean(br);
  let cov = 0;
  let variance = 0;
  for (let i = 0; i < sr.length; i++) {
    cov += (sr[i] - sm) * (br[i] - bm);
    variance += (br[i] - bm) ** 2;
  }
  if (!(variance > 0)) return null;
  return usable(cov / variance);
}

/**
 * One feature row per traded session, oldest first.
 *
 * `asOfDate` truncates the series, which is how leakage is prevented at the
 * boundary that matters: evaluating 2026-08-10 must produce the same row whether
 * or not September's bars exist in the database today.
 */
export function buildFeatureRows(bars: Bar[], benchmarkBars: Bar[] = [], asOfDate?: string): FeatureRow[] {
  const all = sessionsOf(bars);
  const sessions = asOfDate ? all.filter((s) => s.date <= asOfDate) : all;
  if (sessions.length === 0) return [];

  // Benchmark returns keyed by the SYMBOL's session index, aligned on dates where
  // both series traded.
  const pairs = alignSeries(
    sessions.map((s) => ({ date: s.date, open: null, high: null, low: null, close: s.close, volume: 1, adjClose: s.close })),
    benchmarkBars.filter((b) => !asOfDate || b.date <= asOfDate),
    adjusted,
  );
  const pairIndexByDate = new Map(pairs.map((pair, index) => [pair.date, index]));

  const rows: FeatureRow[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const today = sessions[i];
    const yesterday = sessions[i - 1];
    const history = sessions.slice(0, i);                 // strictly before today

    const priorCloses = history.map((s) => s.close);
    const priorReturns: number[] = [];
    for (let k = 1; k < history.length; k++) {
      const r = Math.log(history[k].close / history[k - 1].close);
      if (Number.isFinite(r)) priorReturns.push(r);
    }

    const dailyReturn = usable(today.close / yesterday.close - 1);
    const vol = stdev(priorReturns.slice(-VOL_WINDOW));
    const priorVolumes = history.slice(-VOLUME_WINDOW).map((s) => s.volume).filter((v) => finite(v) && v > 0);
    const medianVolume = median(priorVolumes);
    const priorMa = priorCloses.length >= MA_WINDOW ? mean(priorCloses.slice(-MA_WINDOW)) : null;
    const rangeWindow = priorCloses.slice(-RANGE_WINDOW);
    const rangeHigh = rangeWindow.length >= RANGE_WINDOW ? Math.max(...rangeWindow) : null;
    const rangeLow = rangeWindow.length >= RANGE_WINDOW ? Math.min(...rangeWindow) : null;

    const values: Partial<Record<FeatureName, number>> = {};
    if (dailyReturn != null) values.daily_return = dailyReturn;
    // Standardised against the volatility that was known BEFORE today's move.
    if (dailyReturn != null && vol != null && vol > 0) {
      const z = usable(dailyReturn / vol);
      if (z != null) values.standardized_return = z;
    }
    if (vol != null) values.realized_volatility = vol;
    // Volume is a ratio in logs, so 2× and ½× are symmetric. A zero-volume day is
    // already excluded as a non-traded session, so the log is always defined.
    if (medianVolume != null && medianVolume > 0 && today.volume > 0) {
      const relative = usable(Math.log(today.volume / medianVolume));
      if (relative != null) values.log_relative_volume = relative;
    }
    if (priorMa != null && priorMa > 0) {
      const distance = usable(today.close / priorMa - 1);
      if (distance != null) values.distance_from_ma20 = distance;
    }
    if (rangeHigh != null && rangeLow != null && rangeHigh > rangeLow) {
      // 0 at the 20-day low, 1 at the high, outside [0,1] on a break. Deliberately
      // unclamped: a break is exactly the state worth being able to see.
      const position = usable((today.close - rangeLow) / (rangeHigh - rangeLow));
      if (position != null) values.range_position = position;
    }
    // The gap is measured on the raw series, both sides — the same reasoning the
    // change engine uses, so dividend adjustment cannot manufacture a gap.
    if (today.open != null && yesterday.rawClose != null && yesterday.rawClose > 0) {
      const gap = usable(today.open / yesterday.rawClose - 1);
      if (gap != null) values.gap_return = gap;
    }

    const pairIndex = pairIndexByDate.get(today.date);
    if (pairIndex != null && pairIndex > 0 && dailyReturn != null) {
      const beta = trailingBeta(pairs, pairIndex);
      const benchmarkReturn = usable(pairs[pairIndex].b / pairs[pairIndex - 1].b - 1);
      if (beta != null && benchmarkReturn != null) {
        const residual = usable(dailyReturn - beta * benchmarkReturn);
        if (residual != null) values.benchmark_residual = residual;
      }
    }

    rows.push({ date: today.date, values });
  }
  return rows;
}

/**
 * Turns feature rows into a matrix the model can fit.
 *
 * Column selection is per security and explicit: a feature present for less than
 * 90% of the security's sessions is dropped rather than imputed, because a column
 * that only exists for part of the history would make the model's notion of
 * "unusual" change halfway through the window. `required` keeps a column only if
 * the row being evaluated also has it, so fitting and scoring always see the same
 * feature space.
 */
export function toMatrix(rows: FeatureRow[], required?: FeatureRow): FeatureMatrix {
  if (rows.length === 0) return { columns: [], rows: [], dropped: 0 };
  const columns = FEATURE_NAMES.filter((name) => {
    const present = rows.filter((row) => row.values[name] != null).length;
    if (present / rows.length < COLUMN_COVERAGE) return false;
    return required ? required.values[name] != null : true;
  });
  if (columns.length === 0) return { columns: [], rows: [], dropped: rows.length };

  const kept: FeatureMatrix["rows"] = [];
  let dropped = 0;
  for (const row of rows) {
    const vector = columns.map((name) => row.values[name]);
    if (vector.some((v) => v == null || !Number.isFinite(v))) { dropped++; continue; }
    kept.push({ date: row.date, vector: vector as number[], values: row.values });
  }
  return { columns, rows: kept, dropped };
}
