import type { Bar } from "./market/types";
import type { ThesisParams } from "./thesis-engine";
import { breakoutConfirmed, medianVolume, priceInRange } from "./thesis-conditions";
export type ReplayOccurrence = { started: string; resolved: string | null; sessions: number; alreadyActiveAtWindowStart: boolean };
export type ThesisReplayResult = { status: "ready" | "unsupported" | "insufficient"; message: string; sessions: number; from: string | null; through: string | null; occurrences: ReplayOccurrence[]; resolved: number; longest: number; medianDistancePercent: number | null };
/** Pure counterfactual analysis. No writes, synthetic intraday points or persisted verdicts. */
export function replayThesis(type: string, params: ThesisParams, input: Bar[]): ThesisReplayResult {
  const empty: ThesisReplayResult = { status: "insufficient", message: "Not enough observed history to replay this condition yet.", sessions: 0, from: null, through: null, occurrences: [], resolved: 0, longest: 0, medianDistancePercent: null };
  if (type === "none") return { ...empty, status: "unsupported", message: "Add a structured condition to use Thesis Replay." };
  if (type !== "price_range" && type !== "breakout") return { ...empty, status: "unsupported", message: "Historical occurrence analysis currently supports price ranges and volume-confirmed breakouts. This condition’s maintenance/anomaly semantics are not supported yet." };
  if ((type === "price_range" && !(params.low != null && params.high != null && params.low > 0 && params.low <= params.high && Number.isFinite(params.high))) || (type === "breakout" && !(params.level != null && Number.isFinite(params.level) && params.level > 0))) return { ...empty, status: "unsupported", message: "This condition does not have valid replay parameters." };
  const all = [...new Map(input.map((b) => [b.date, b])).values()].filter((b) => {
    const close = type === "price_range" ? b.close : b.adjClose ?? b.close;
    return /^\d{4}-\d{2}-\d{2}$/.test(b.date) && close != null && Number.isFinite(close) && close > 0 && b.volume != null && Number.isFinite(b.volume) && b.volume > 0;
  }).sort((a, b) => a.date.localeCompare(b.date));
  const window = (type === "breakout" ? all.slice(19) : all).slice(-60);
  if (window.length < 2) return empty;
  const occurrences: ReplayOccurrence[] = [], distances: number[] = [];
  let active: ReplayOccurrence | null = null;
  for (const [index, bar] of window.entries()) {
    const close = (type === "price_range" ? bar.close : bar.adjClose ?? bar.close)!;
    const met = type === "price_range" ? priceInRange(close, params.low!, params.high!) : breakoutConfirmed(close, params.level!, bar.volume!, medianVolume(all, bar.date, 20) ?? 0);
    if (met) {
      if (!active) { active = { started: bar.date, resolved: null, sessions: 0, alreadyActiveAtWindowStart: index === 0 }; occurrences.push(active); }
      active.sessions++;
      distances.push(type === "price_range" ? (params.high! - close) / params.high! * 100 : (close - params.level!) / params.level! * 100);
    } else if (active) { active.resolved = bar.date; active = null; }
  }
  distances.sort((a, b) => a - b);
  const mid = Math.floor(distances.length / 2);
  const median = distances.length ? distances.length % 2 ? distances[mid] : (distances[mid - 1] + distances[mid]) / 2 : null;
  return { status: "ready", message: "Daily-close observations only. Consecutive qualifying closes form one occurrence; a later non-qualifying close resolves it. Gaps and intraday crossings are unknown. These are not stored monitoring events.", sessions: window.length, from: window[0].date, through: window.at(-1)!.date, occurrences, resolved: occurrences.filter((o) => o.resolved).length, longest: Math.max(0, ...occurrences.map((o) => o.sessions)), medianDistancePercent: median != null && Number.isFinite(median) ? median : null };
}
