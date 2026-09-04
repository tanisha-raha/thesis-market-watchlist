/**
 * Trading calendar derived from observed bars, never from a hardcoded holiday list.
 *
 * The naive version of this — "a bar exists, therefore the market traded" — is
 * WRONG, and Phase 0 caught it. Yahoo emits phantom bars on NSE holidays:
 *
 *   2026-01-15, 2026-05-01, 2026-05-28, 2026-06-26 (and 2025-03-18)
 *     equities → a real, carried-forward close with volume: 0
 *     indices  → close: null
 *
 * Identical dates across RELIANCE, HDFCBANK, TCS, INFY and SBIN, which is not a
 * coincidence — those are non-trading days. A calendar built from bar presence
 * would call them trading days, and "market closed since your last visit" would
 * then be wrong on exactly the days it matters most.
 *
 * The correct rule is that a session must show evidence of *trading*, not merely
 * the existence of a row.
 */
import type { Bar } from "./types";

/** A session traded if a real price printed AND shares actually changed hands. */
export function isTradedEquityBar(bar: Bar): boolean {
  return bar.close != null && bar.volume != null && bar.volume > 0;
}

/**
 * Trading dates implied by one symbol's bars.
 *
 * Note the deliberate asymmetry with indices: an index has no volume, so it can
 * never satisfy `isTradedEquityBar`. Calendars are derived from liquid equities
 * only, and indices are then filtered *against* that calendar.
 */
export function tradingDatesFrom(bars: Bar[]): Set<string> {
  return new Set(bars.filter(isTradedEquityBar).map((b) => b.date));
}

/**
 * Consensus calendar across several liquid symbols.
 *
 * A single symbol can be halted, suspended, or newly listed, so one symbol's
 * silence is not the market's. A date counts as a session when at least
 * `quorum` of the reference symbols traded on it.
 */
export function deriveTradingCalendar(
  barsBySymbol: Bar[][],
  quorum = Math.ceil(barsBySymbol.length / 2),
): Set<string> {
  const votes = new Map<string, number>();
  for (const bars of barsBySymbol) {
    for (const date of tradingDatesFrom(bars)) {
      votes.set(date, (votes.get(date) ?? 0) + 1);
    }
  }
  return new Set([...votes].filter(([, n]) => n >= quorum).map(([d]) => d));
}

/** Trading sessions in (after, until]. The basis for "market closed since your last visit". */
export function sessionsBetween(calendar: Set<string>, after: string, until: string): string[] {
  return [...calendar].filter((d) => d > after && d <= until).sort();
}

/**
 * Aligns two series to dates where BOTH have a usable close.
 *
 * Required for beta and residuals. Joining on date alone is not enough: index
 * series carry null closes on holidays while equities carry a stale close, so a
 * naive join silently produces NaN. This is not hypothetical — it is the bug
 * that appeared the first time we computed a bank beta in Phase 0.
 */
export function alignSeries(
  a: Bar[],
  b: Bar[],
  /** Which price to align on. Defaults to the close; stats align on the adjusted close. */
  value: (bar: Bar) => number | null = (bar) => bar.close,
): { date: string; a: number; b: number }[] {
  const usable = (bar: Bar) => {
    const v = value(bar);
    return v != null && Number.isFinite(v) ? v : null;
  };
  const bByDate = new Map<string, number>();
  for (const bar of b) {
    const v = usable(bar);
    if (v != null) bByDate.set(bar.date, v);
  }
  const out: { date: string; a: number; b: number }[] = [];
  for (const bar of a) {
    const v = usable(bar);
    if (v == null) continue;
    const other = bByDate.get(bar.date);
    if (other == null) continue;
    out.push({ date: bar.date, a: v, b: other });
  }
  return out;
}
