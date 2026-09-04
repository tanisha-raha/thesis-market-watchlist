/**
 * The capped symbol universe the deployed app polls.
 *
 * The brief caps this at 50–100 symbols on a fixed schedule: cost is O(unique
 * symbols), and batched quote() resolves 50 per HTTP request, so this whole list
 * is one or two requests per poll.
 *
 * NIFTY 50 constituents plus the benchmark. TATAMOTORS.NS is deliberately absent
 * — Phase 0 found it no longer resolves after the demerger, and seeding a symbol
 * we know is dead would manufacture the exact feed-health alarm we built the
 * transient/terminal distinction to avoid.
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

/** Everything we fetch or poll, benchmark included. */
export const FULL_UNIVERSE: string[] = [BENCHMARK, ...EQUITY_UNIVERSE];
