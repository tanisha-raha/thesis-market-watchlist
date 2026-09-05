import type { HistoryPoint } from "./presentation";

/**
 * Which chart ranges a security can honestly offer.
 *
 * Pure, because the rule matters more than the rendering: a range is offered ONLY
 * when the data path can actually produce observations for it. Intraday ranges
 * come from the observed price path and daily ranges from stored or provider
 * bars, and a symbol we hold three months of daily bars for simply does not get
 * a 1D button rather than getting a straight line drawn between two closes.
 */

export type RangeKey = "1D" | "1W" | "1M" | "3M" | "1Y";

/** One point on the observed intraday path: an instant, not a session. */
export type IntradayPoint = { at: string; price: number };

/** The most points we will ever send to the browser for one range. */
const MAX_POINTS = 320;

/** Sessions each daily range covers. Trading sessions, not calendar days. */
const DAILY_SESSIONS: Record<"1M" | "3M" | "1Y", number> = { "1M": 22, "3M": 66, "1Y": 252 };

/** A range needs enough points to describe a shape rather than imply one. */
const MIN_POINTS = 3;

const finite = (n: number) => Number.isFinite(n) && n > 0;

/** Evenly thins a series to at most `max` points, always keeping the last one. */
function downsample<T>(points: T[], max = MAX_POINTS): T[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function usableDaily(daily: HistoryPoint[]): HistoryPoint[] {
  return daily.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && finite(p.close));
}

function usableIntraday(intraday: IntradayPoint[]): IntradayPoint[] {
  return intraday
    .filter((p) => finite(p.price) && Number.isFinite(new Date(p.at).getTime()))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The observations inside one range.
 *
 * 1D is the latest observed session only — whatever that exchange's last session
 * was, which is not necessarily today. 1W is the last seven days of the observed
 * path. Both return an empty series rather than falling back to daily closes: a
 * "1D" chart drawn from one close per day would be a different measurement
 * wearing the same label.
 */
export function rangeSeries(
  range: RangeKey,
  daily: HistoryPoint[],
  intraday: IntradayPoint[],
  exchangeDateOf: (at: Date) => string,
): { daily: HistoryPoint[]; intraday: IntradayPoint[] } {
  if (range === "1D" || range === "1W") {
    const points = usableIntraday(intraday);
    if (points.length === 0) return { daily: [], intraday: [] };
    const last = new Date(points[points.length - 1].at);
    const from = range === "1D"
      ? exchangeDateOf(last)
      : exchangeDateOf(new Date(last.getTime() - 7 * 864e5));
    const inRange = points.filter((p) => exchangeDateOf(new Date(p.at)) >= from);
    return { daily: [], intraday: downsample(inRange) };
  }
  const sessions = usableDaily(daily);
  return { daily: downsample(sessions.slice(-DAILY_SESSIONS[range])), intraday: [] };
}

/** Every range this security has real observations for, longest last. */
export function availableRanges(
  daily: HistoryPoint[],
  intraday: IntradayPoint[],
  exchangeDateOf: (at: Date) => string,
): RangeKey[] {
  const all: RangeKey[] = ["1D", "1W", "1M", "3M", "1Y"];
  return all.filter((range) => {
    const series = rangeSeries(range, daily, intraday, exchangeDateOf);
    return series.daily.length + series.intraday.length >= MIN_POINTS;
  });
}

/**
 * Which range to show first.
 *
 * Three months where we have it: long enough to show a trend, short enough that
 * the last few weeks are still legible. Otherwise the longest range available.
 */
export function defaultRange(available: RangeKey[]): RangeKey | null {
  if (available.length === 0) return null;
  return available.includes("3M") ? "3M" : available[available.length - 1];
}
