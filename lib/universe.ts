import { BENCHMARK_SYMBOLS } from "./securities";

/**
 * The capped symbol universe the deployed app polls.
 *
 * The brief caps this at 50–100 symbols on a fixed schedule: cost is O(unique
 * symbols), and batched quote() resolves 50 per HTTP request, so this whole list
 * is one or two requests per poll.
 *
 * NIFTY 50 constituents plus the US names below and both benchmarks.
 * TATAMOTORS.NS is deliberately absent
 * — Phase 0 found it no longer resolves after the demerger, and seeding a symbol
 * we know is dead would manufacture the exact feed-health alarm we built the
 * transient/terminal distinction to avoid.
 */

/**
 * The Indian benchmark. Kept as a named export because the seeded Indian
 * universe is built around it; per-security benchmark selection now lives in
 * lib/securities.ts, which is what a US symbol resolves through.
 */
export const BENCHMARK = "^NSEI";

export const EQUITY_UNIVERSE = [
  "RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS",
  "SBIN.NS", "BHARTIARTL.NS", "ITC.NS", "LT.NS", "KOTAKBANK.NS",
  "AXISBANK.NS", "HINDUNILVR.NS", "BAJFINANCE.NS", "MARUTI.NS", "SUNPHARMA.NS",
  "TITAN.NS", "ULTRACEMCO.NS", "WIPRO.NS", "NESTLEIND.NS", "ADANIENT.NS",
  "ASIANPAINT.NS", "BAJAJFINSV.NS", "BPCL.NS", "CIPLA.NS", "COALINDIA.NS",
  "DIVISLAB.NS", "DRREDDY.NS", "EICHERMOT.NS", "GRASIM.NS", "HCLTECH.NS",
  "HDFCLIFE.NS", "HEROMOTOCO.NS", "HINDALCO.NS", "INDUSINDBK.NS", "JSWSTEEL.NS",
  "M&M.NS", "NTPC.NS", "ONGC.NS", "POWERGRID.NS", "SBILIFE.NS",
  "TATACONSUM.NS", "TATASTEEL.NS", "TECHM.NS", "APOLLOHOSP.NS", "BRITANNIA.NS",
  "ADANIPORTS.NS", "BAJAJ-AUTO.NS", "SHREECEM.NS", "UPL.NS", "TRENT.NS",
] as const;

/**
 * The US names the deployed app monitors on the same schedule.
 *
 * Eight, not five hundred. The seeded universe is what we can hold real history
 * for — and history is what statistics, detection and replay are computed from,
 * so a symbol in this list is one the product can genuinely reason about rather
 * than merely quote. A user can still watch any symbol the provider resolves;
 * one with no stored history says so on its own page instead of pretending.
 */
export const US_EQUITY_UNIVERSE = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA", "JPM", "BLK",
] as const;

/**
 * Everything we fetch or poll, benchmarks included.
 *
 * Both market benchmarks are polled even though the fixed equity universe is
 * Indian: a user can watch a US security, and its benchmark has to be a symbol
 * we actually hold a current quote for. Anything a user watches beyond this
 * list is added per poll by the ingestion route.
 */
export const FULL_UNIVERSE: string[] = [...BENCHMARK_SYMBOLS, ...EQUITY_UNIVERSE, ...US_EQUITY_UNIVERSE];
