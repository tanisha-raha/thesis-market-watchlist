import { istDate } from "./time";
import { isTradedEquityBar } from "./market/calendar";
import type { Bar } from "./market/types";
import type { SymbolStats } from "./stats";

/**
 * The change engine: detection, scoring, and transient resolution.
 *
 * Pure. No database, no clock, no network — everything is a function of the
 * series passed in, which is what makes the missed-event behaviour testable
 * against seeded history rather than against whatever the market happens to do.
 *
 * FAN-OUT. Detection runs once per symbol and knows nothing about users. The
 * output is shared by everyone watching that symbol, so cost is O(unique
 * symbols) rather than O(users × symbols). Personalisation is a later filter.
 *
 * TRANSIENCE IS THE POINT. Most signals here are not instants, they are
 * conditions that begin to hold and later stop holding. `occurredAt` is when a
 * condition became true and `resolvedAt` is when it stopped; an event whose
 * whole span sits inside a user's away-window is something that fired and
 * reversed before they looked — the one thing a current-state app can never
 * show. Resolution is therefore evaluated against the INTRADAY series. Built on
 * daily bars it would silently never fire, because a move that reverses within
 * the session leaves no trace in a daily close.
 */

export type SignalType =
  | "price_move"
  | "volume_anomaly"
  | "cross_52w_high"
  | "cross_52w_low"
  | "cross_20d_high"
  | "cross_20d_low"
  | "trend_above_ma20"
  | "trend_below_ma20"
  | "overnight_gap"
  | "benchmark_residual";

export type DetectionWindow = "intraday" | "1d";

/** One point on the intraday price path — a live poll or a seeded 5-minute close. */
export type Observation = { at: Date; price: number };

export type DetectedEvent = {
  signalType: SignalType;
  window: DetectionWindow;
  occurredAt: Date;
  /** Null while the condition still holds. Never cleared once set. */
  resolvedAt: Date | null;
  /** The signal's own natural unit: a z-score, a fraction, a log ratio. */
  magnitude: number;
  /** Normalized for internal ranking only — see `scoreOf`. Never displayed. */
  score: number;
  /** The actual inputs at the moment of firing. Rendered as-is, never recomputed. */
  explain: Record<string, unknown>;
};

/* ------------------------------------------------------------------ tuning */

/** A move must reach this many daily sigmas to be worth anyone's attention. */
const Z_FIRE = 2.0;
/** ...and fall back to this before we call it over. The gap is the hysteresis. */
const Z_CLEAR = 1.5;

/** Crossings re-arm only after falling back through this band. 0.5% either side. */
const REARM_BAND = 0.005;

/** Volume counts as anomalous at twice the 20-day median, and clears at 1.2×. */
const VOLUME_FIRE = 2.0;
const VOLUME_CLEAR = 1.2;

/**
 * Within this window a repeat of the same signal must ESCALATE to be emitted
 * again. Moves escalate; they do not repeat.
 */
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** How much bigger a repeat must be, inside the cooldown window, to earn a row. */
const ESCALATION_FACTOR = 1.5;

/* ------------------------------------------------------------------- latch */

/**
 * One sample of a condition being evaluated over time.
 *
 * `active` is whether the condition holds right now. `rearmed` is whether it has
 * fallen back far enough that a NEW event may open — deliberately a separate,
 * stricter test, so a price oscillating a hair either side of its 52-week high
 * produces one event rather than a burst of them.
 */
type Sample = {
  at: Date;
  active: boolean;
  rearmed: boolean;
  magnitude: number;
  explain: () => Record<string, unknown>;
};

/**
 * Walks a condition through time and produces events with open and close times.
 *
 * This is the only place transience is implemented. Every latched signal shares
 * it, so `resolvedAt` cannot be right for one signal and quietly wrong for
 * another.
 */
function latch(
  signalType: SignalType,
  window: DetectionWindow,
  samples: Sample[],
  toScore: (magnitude: number) => number,
): DetectedEvent[] {
  const events: DetectedEvent[] = [];
  let open: DetectedEvent | null = null;
  let armed = true;
  let lastEmitted: { at: Date; magnitude: number } | null = null;

  for (const s of samples) {
    if (open) {
      // The condition stopped holding: the event is over. `resolvedAt` is the
      // moment it ceased to be true, NOT the moment it re-armed — the honest
      // answer to "when did this reverse".
      if (!s.active) {
        open.resolvedAt = s.at;
        open = null;
        armed = false;             // must clear the re-arm band before firing again
      }
      // While it holds, we leave the event exactly as it was recorded. The
      // magnitude and explain describe the moment it fired, which is what the
      // evidence panel will claim they describe.
      continue;
    }

    if (!armed) {
      if (s.rearmed) armed = true;
      // Deliberately no `continue` — a sample that re-arms can also be the one
      // that fires again, and dropping it would lose a legitimate event.
      else continue;
    }

    if (!s.active) continue;

    // Cooldown with escalation. Outside the window, fire normally. Inside it,
    // only fire if this move meaningfully exceeds the one we already reported.
    if (lastEmitted && s.at.getTime() - lastEmitted.at.getTime() < COOLDOWN_MS) {
      if (Math.abs(s.magnitude) < Math.abs(lastEmitted.magnitude) * ESCALATION_FACTOR) continue;
    }

    open = {
      signalType,
      window,
      occurredAt: s.at,
      resolvedAt: null,
      magnitude: s.magnitude,
      score: toScore(s.magnitude),
      explain: s.explain(),
    };
    events.push(open);
    lastEmitted = { at: s.at, magnitude: s.magnitude };
  }

  return events;
}

/* ------------------------------------------------------------------ inputs */

export type DetectionInput = {
  symbol: string;
  stats: SymbolStats;
  /** Intraday price path, ascending by time. Resolution depends on this. */
  observations: Observation[];
  /** Daily bars, ascending by trading date. */
  dailyBars: Bar[];
  /** Benchmark daily bars, for the relative residual. */
  benchmarkBars: Bar[];
  /** Ignore anything before this instant. */
  since?: Date;
};

const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const adjusted = (b: Bar) => {
  const v = b.adjClose ?? b.close;
  return finite(v) && v > 0 ? v : null;
};

/**
 * Previous traded close for each trading date.
 *
 * `pick` chooses which series to walk, and the choice matters. The overnight gap
 * compares the session OPEN against it, and the provider gives us only a raw
 * open — so the gap must use the raw close too. Mixing them silently biases
 * every gap by the dividend adjustment: for RELIANCE the adjusted/raw ratio ran
 * to 0.99144, which against a daily volatility of ~0.9% is a full sigma of pure
 * artefact. That is the same class of error as computing a 52-week high across a
 * split, and it fired thousands of phantom gaps before it was caught.
 */
function previousCloseByDate(bars: Bar[], pick: (b: Bar) => number | null = adjusted): Map<string, number> {
  const out = new Map<string, number>();
  let prev: number | null = null;
  for (const b of bars) {
    if (!isTradedEquityBar(b)) continue;
    const close = pick(b);
    if (close == null || close <= 0) continue;
    if (prev != null) out.set(b.date, prev);
    prev = close;
  }
  return out;
}

/** The unadjusted close, for comparisons against the equally unadjusted open. */
const rawClose = (b: Bar) => (finite(b.close) && b.close > 0 ? b.close : null);

/* ----------------------------------------------------------------- signals */

/**
 * Intraday signals: everything whose reversal we want to be able to show.
 *
 * All of these are evaluated per observation against the intraday path, which is
 * what makes a fire-and-reverse detectable at all.
 */
function intradaySignals(input: DetectionInput): DetectedEvent[] {
  const { stats, observations } = input;
  const vol = finite(stats.realizedVol20) && stats.realizedVol20 > 0 ? stats.realizedVol20 : null;
  const prevCloseFor = previousCloseByDate(input.dailyBars);
  const since = input.since?.getTime() ?? -Infinity;

  const points = observations
    .filter((o) => finite(o.price) && o.price > 0 && o.at.getTime() >= since)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (points.length === 0) return [];

  const events: DetectedEvent[] = [];

  /** Builds samples for a level crossing and latches them. */
  const crossing = (
    signalType: SignalType,
    level: number | null,
    direction: "above" | "below",
  ) => {
    if (!finite(level) || level <= 0) return;
    const rearmLevel = direction === "above" ? level * (1 - REARM_BAND) : level * (1 + REARM_BAND);

    const samples: Sample[] = points.map((p) => {
      const magnitude = direction === "above" ? p.price / level - 1 : 1 - p.price / level;
      return {
        at: p.at,
        active: direction === "above" ? p.price > level : p.price < level,
        rearmed: direction === "above" ? p.price < rearmLevel : p.price > rearmLevel,
        magnitude,
        explain: () => ({
          signal: signalType,
          price: p.price,
          level,
          level_source: signalType.includes("52w") ? "52-week (adjusted closes)" : "20-day range",
          distance_from_level_pct: magnitude * 100,
          rearm_level: rearmLevel,
          rearm_band_pct: REARM_BAND * 100,
          realized_vol_20d_daily: stats.realizedVol20,
          sigmas_beyond_level: vol ? magnitude / vol : null,
          observed_at: p.at.toISOString(),
        }),
      };
    });

    events.push(...latch(signalType, "intraday", samples, (m) => (vol ? Math.abs(m) / vol : Math.abs(m) * 100)));
  };

  crossing("cross_52w_high", stats.high52w, "above");
  crossing("cross_52w_low", stats.low52w, "below");
  crossing("cross_20d_high", stats.high20, "above");
  crossing("cross_20d_low", stats.low20, "below");

  // --- volatility-normalized price move, against the previous session's close --
  if (vol) {
    const samples: Sample[] = [];
    for (const p of points) {
      const prevClose = prevCloseFor.get(istDate(p.at));
      if (!finite(prevClose) || prevClose <= 0) continue;
      const ret = p.price / prevClose - 1;
      const z = ret / vol;                       // window is one day, so √1
      samples.push({
        at: p.at,
        active: Math.abs(z) >= Z_FIRE,
        rearmed: Math.abs(z) < Z_CLEAR,
        magnitude: z,
        explain: () => ({
          signal: "price_move",
          price: p.price,
          previous_close: prevClose,
          return_pct: ret * 100,
          realized_vol_20d_daily: vol,
          z_vs_20d_realized_vol: z,
          fire_threshold_z: Z_FIRE,
          clear_threshold_z: Z_CLEAR,
          observed_at: p.at.toISOString(),
        }),
      });
    }
    events.push(...latch("price_move", "intraday", samples, Math.abs));
  }

  // --- trend state relative to the 20-day moving average ----------------------
  if (finite(stats.ma20) && stats.ma20 > 0) {
    const ma = stats.ma20;
    for (const [signalType, dir] of [["trend_above_ma20", "above"], ["trend_below_ma20", "below"]] as const) {
      const rearmLevel = dir === "above" ? ma * (1 - REARM_BAND) : ma * (1 + REARM_BAND);
      const samples: Sample[] = points.map((p) => ({
        at: p.at,
        active: dir === "above" ? p.price > ma : p.price < ma,
        rearmed: dir === "above" ? p.price < rearmLevel : p.price > rearmLevel,
        magnitude: dir === "above" ? p.price / ma - 1 : 1 - p.price / ma,
        explain: () => ({
          signal: signalType,
          price: p.price,
          ma_20d: ma,
          distance_from_ma_pct: (dir === "above" ? p.price / ma - 1 : 1 - p.price / ma) * 100,
          realized_vol_20d_daily: stats.realizedVol20,
          observed_at: p.at.toISOString(),
        }),
      }));
      events.push(...latch(signalType, "intraday", samples, (m) => (vol ? Math.abs(m) / vol : Math.abs(m) * 100)));
    }
  }

  return events;
}

/**
 * Daily signals: volume, the overnight gap, and the benchmark-relative residual.
 *
 * These are properties of a session rather than of an instant, so they are
 * evaluated on daily bars. Traded sessions only — a phantom holiday bar carries
 * a carried-forward close and zero volume, and would otherwise read as a total
 * volume collapse.
 */
function dailySignals(input: DetectionInput): DetectedEvent[] {
  const { stats } = input;
  const vol = finite(stats.realizedVol20) && stats.realizedVol20 > 0 ? stats.realizedVol20 : null;
  const since = input.since?.getTime() ?? -Infinity;
  const bars = input.dailyBars.filter(isTradedEquityBar);
  const events: DetectedEvent[] = [];

  /** A session's close is timestamped at the NSE close, 15:30 IST = 10:00 UTC. */
  const sessionInstant = (date: string) => new Date(`${date}T10:00:00.000Z`);

  // --- volume anomaly ---------------------------------------------------------
  if (finite(stats.medianVolume20) && stats.medianVolume20 > 0) {
    const median = stats.medianVolume20;
    const samples: Sample[] = bars
      .filter((b) => finite(b.volume) && b.volume > 0)
      .map((b) => {
        const ratio = b.volume! / median;
        return {
          at: sessionInstant(b.date),
          active: ratio >= VOLUME_FIRE,
          rearmed: ratio < VOLUME_CLEAR,
          magnitude: Math.log(ratio),
          explain: () => ({
            signal: "volume_anomaly",
            trading_date: b.date,
            volume: b.volume,
            median_volume_20d: median,
            volume_vs_median: ratio,
            log_ratio: Math.log(ratio),
            fire_threshold_multiple: VOLUME_FIRE,
            clear_threshold_multiple: VOLUME_CLEAR,
          }),
        };
      })
      .filter((s) => s.at.getTime() >= since);
    events.push(...latch("volume_anomaly", "1d", samples, (m) => Math.abs(m) / Math.LN2));
  }

  // --- overnight gap ----------------------------------------------------------
  // A point event: a gap happened at the open. It does not later un-happen, so
  // it carries no resolvedAt. Any subsequent reversal shows up as a price_move.
  if (vol) {
    // Raw series on both sides — see previousCloseByDate.
    const prevCloseFor = previousCloseByDate(input.dailyBars, rawClose);
    for (const b of bars) {
      const prevClose = prevCloseFor.get(b.date);
      const open = finite(b.open) && b.open > 0 ? b.open : null;
      if (!finite(prevClose) || prevClose <= 0 || open == null) continue;
      const gap = open / prevClose - 1;
      const z = gap / vol;
      if (Math.abs(z) < Z_FIRE) continue;
      const at = new Date(`${b.date}T03:45:00.000Z`);   // 09:15 IST open
      if (at.getTime() < since) continue;
      events.push({
        signalType: "overnight_gap",
        window: "1d",
        occurredAt: at,
        resolvedAt: null,
        magnitude: z,
        score: Math.abs(z),
        explain: {
          signal: "overnight_gap",
          trading_date: b.date,
          previous_close_raw: prevClose,
          open,
          gap_pct: gap * 100,
          series_note: "open and previous close are both unadjusted, so the gap is not distorted by dividend adjustment",
          realized_vol_20d_daily: vol,
          z_vs_20d_realized_vol: z,
          fire_threshold_z: Z_FIRE,
        },
      });
    }
  }

  // --- benchmark-relative residual -------------------------------------------
  // If the market moved and the stock followed, that is not a signal.
  if (vol && finite(stats.beta60)) {
    const beta = stats.beta60;
    const benchByDate = new Map<string, number>();
    for (const b of input.benchmarkBars) {
      const c = adjusted(b);
      if (c != null) benchByDate.set(b.date, c);
    }
    const prevCloseFor = previousCloseByDate(input.dailyBars);

    const benchDates = [...benchByDate.keys()].sort();
    const prevBench = new Map<string, number>();
    for (let i = 1; i < benchDates.length; i++) prevBench.set(benchDates[i], benchByDate.get(benchDates[i - 1])!);

    const samples: Sample[] = [];
    for (const b of bars) {
      const close = adjusted(b);
      const prevClose = prevCloseFor.get(b.date);
      const idx = benchByDate.get(b.date);
      const idxPrev = prevBench.get(b.date);
      if (close == null || !finite(prevClose) || !finite(idx) || !finite(idxPrev)) continue;
      if (prevClose <= 0 || idxPrev <= 0) continue;

      const rStock = close / prevClose - 1;
      const rIndex = idx / idxPrev - 1;
      const residual = rStock - beta * rIndex;
      const z = residual / vol;
      const at = sessionInstant(b.date);
      if (at.getTime() < since) continue;

      samples.push({
        at,
        active: Math.abs(z) >= Z_FIRE,
        rearmed: Math.abs(z) < Z_CLEAR,
        magnitude: z,
        explain: () => ({
          signal: "benchmark_residual",
          trading_date: b.date,
          stock_return_pct: rStock * 100,
          benchmark: "^NSEI",
          benchmark_return_pct: rIndex * 100,
          beta_60d: beta,
          expected_from_benchmark_pct: beta * rIndex * 100,
          residual_pct: residual * 100,
          realized_vol_20d_daily: vol,
          z_vs_20d_realized_vol: z,
          fire_threshold_z: Z_FIRE,
        }),
      });
    }
    events.push(...latch("benchmark_residual", "1d", samples, Math.abs));
  }

  return events;
}

/**
 * All events for one symbol, ordered by when they occurred.
 *
 * `score` is expressed in daily-volatility units for price-based signals and in
 * doublings for volume. It exists only to rank a digest; it is never rendered,
 * and nothing derived from it is ever shown to a user. What gets shown is
 * `explain`, in real units.
 */
export function detectEvents(input: DetectionInput): DetectedEvent[] {
  return [...intradaySignals(input), ...dailySignals(input)]
    .filter((e) => Number.isFinite(e.magnitude) && Number.isFinite(e.score))
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** An event that fired and reversed entirely inside a window the user was away for. */
export function isMissedEvent(event: DetectedEvent, awayFrom: Date, awayUntil: Date): boolean {
  return (
    event.resolvedAt != null &&
    event.occurredAt.getTime() >= awayFrom.getTime() &&
    event.resolvedAt.getTime() <= awayUntil.getTime()
  );
}
