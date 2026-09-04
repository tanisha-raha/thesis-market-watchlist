import { alignSeries, isTradedEquityBar } from "./market/calendar";
import type { Bar } from "./market/types";

/**
 * Per-symbol statistics. This table is what turns a hardcoded threshold into a
 * judgement: a 4% move means nothing until it is measured against how much this
 * symbol usually moves.
 *
 * Two rules hold throughout.
 *
 * ADJUSTED SERIES ONLY. Every level and every return uses the adjusted close.
 * On the unadjusted series a split silently corrupts the 52-week high, which is
 * the exact failure the corporate-actions work exists to prevent.
 *
 * TRADED SESSIONS ONLY. Yahoo emits phantom bars on NSE holidays — a real,
 * carried-forward close with `volume: 0` (Phase 0 found 2026-01-15, 2026-05-01,
 * 2026-05-28, 2026-06-26 among others). Including them injects a spurious 0%
 * return that deflates realized volatility, and realized volatility is the
 * denominator everything else is normalized by.
 */

export type SymbolStats = {
  realizedVol20: number | null;
  medianVolume20: number | null;
  ma20: number | null;
  beta60: number | null;
  high52w: number | null;
  low52w: number | null;
  high20: number | null;
  low20: number | null;
  sessionsUsed: number;
};

/** Trading sessions in a year. 52-week levels are a count of sessions, not calendar days. */
const SESSIONS_PER_YEAR = 252;

const isFinite_ = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/** Adjusted close, falling back to the close when no adjusted value is present. */
const adjusted = (bar: Bar): number | null => {
  const v = bar.adjClose ?? bar.close;
  return isFinite_(v) && v > 0 ? v : null;
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Log returns of a price series. Guarded so a zero or missing price cannot emit NaN. */
function logReturns(prices: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] <= 0 || prices[i] <= 0) continue;
    const r = Math.log(prices[i] / prices[i - 1]);
    if (Number.isFinite(r)) out.push(r);
  }
  return out;
}

/** Sample standard deviation. Null below two observations rather than 0, which would be a lie. */
function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
  return Number.isFinite(v) && v >= 0 ? Math.sqrt(v) : null;
}

/**
 * Ordinary-least-squares beta of the symbol against the benchmark.
 *
 * Alignment is delegated to `alignSeries`, which drops any date where either
 * series lacks a usable price. Joining on date alone is not sufficient: index
 * series carry null closes on holidays while equities carry a stale one, and the
 * naive join silently produces NaN. That bug is not hypothetical — it appeared
 * the first time we computed a bank beta during Phase 0.
 */
function beta(symbolBars: Bar[], benchmarkBars: Bar[], window: number): number | null {
  const pairs = alignSeries(symbolBars, benchmarkBars, adjusted).slice(-(window + 1));
  if (pairs.length < 3) return null;

  const sr = logReturns(pairs.map((p) => p.a));
  const br = logReturns(pairs.map((p) => p.b));
  if (sr.length !== br.length || sr.length < 2) return null;

  const sm = mean(sr);
  const bm = mean(br);
  let cov = 0;
  let variance = 0;
  for (let i = 0; i < sr.length; i++) {
    cov += (sr[i] - sm) * (br[i] - bm);
    variance += (br[i] - bm) ** 2;
  }
  if (!(variance > 0)) return null;      // a flat benchmark has no beta to measure
  const b = cov / variance;
  return Number.isFinite(b) ? b : null;
}

/** Highest and lowest adjusted close over the last `window` traded sessions. */
function range(prices: number[], window: number): { high: number | null; low: number | null } {
  const w = prices.slice(-window);
  if (w.length === 0) return { high: null, low: null };
  return { high: Math.max(...w), low: Math.min(...w) };
}

export function computeStats(bars: Bar[], benchmark: Bar[]): SymbolStats {
  // Traded sessions only, and only where an adjusted price exists.
  const sessions = bars.filter((b) => isTradedEquityBar(b) && adjusted(b) != null);
  const prices = sessions.map((b) => adjusted(b)!);

  const returns20 = logReturns(prices.slice(-21));
  const last20 = sessions.slice(-20);
  const closes20 = last20.map((b) => adjusted(b)!);

  const r52 = range(prices, SESSIONS_PER_YEAR);
  const r20 = range(prices, 20);

  return {
    // Daily realized volatility. The brief's z-score scales this by √window, so
    // it is deliberately not annualized here.
    realizedVol20: stdev(returns20),
    medianVolume20: median(last20.map((b) => b.volume).filter((v): v is number => isFinite_(v) && v > 0)),
    ma20: closes20.length ? mean(closes20) : null,
    beta60: beta(bars, benchmark, 60),
    // Levels are computed on adjusted CLOSES, not intraday highs and lows. We
    // have no adjusted high/low from the provider, and mixing an unadjusted
    // intraday high with an adjusted close would be incoherent across a split.
    // A close-based 52-week high is slightly conservative and always consistent.
    high52w: r52.high,
    low52w: r52.low,
    high20: r20.high,
    low20: r20.low,
    sessionsUsed: sessions.length,
  };
}
