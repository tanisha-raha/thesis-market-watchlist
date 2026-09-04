/**
 * Phase 0 — data source validation.
 *
 * Answers six questions about yahoo-finance2 before we commit to it:
 *   1. Daily OHLCV completeness for an NSE equity
 *   2. Index series alignment with the equity series
 *   3. Split adjustment correctness (do NOT trust, verify)
 *   4. Do NSE sector indices resolve
 *   5. Where does throttling start, and what does it look like
 *   6. What staleness metadata comes with a live quote
 *
 * Writes reports/phase0.json alongside human-readable stdout.
 * Run: npx tsx scripts/validate-source.ts
 */
import YahooFinance from "yahoo-finance2";
import { writeFileSync } from "node:fs";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

const report: Record<string, unknown> = { runAt: new Date().toISOString() };
const log = (...a: unknown[]) => console.log(...a);
const hr = (t: string) => log(`\n${"=".repeat(64)}\n${t}\n${"=".repeat(64)}`);

const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);
const iso = (d: Date | number) => new Date(d).toISOString().slice(0, 10);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

type Bar = {
  date: Date; open: number | null; high: number | null; low: number | null;
  close: number | null; volume: number | null; adjclose?: number | null;
};

async function chart(symbol: string, from: Date, opts: Record<string, unknown> = {}) {
  return yf.chart(symbol, { period1: from, period2: new Date(), interval: "1d", ...opts });
}

/** Count weekdays in [from, to] — a crude expected-trading-day baseline (ignores holidays). */
function weekdaysBetween(from: Date, to: Date) {
  let n = 0;
  for (let d = new Date(from); d <= to; d = new Date(+d + 864e5)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

/** Runs of >3 calendar days between consecutive bars = suspected gap (not just a weekend). */
function findGaps(bars: Bar[]) {
  const gaps: { after: string; before: string; calendarDays: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const d = (+bars[i].date - +bars[i - 1].date) / 864e5;
    if (d > 3) gaps.push({ after: iso(bars[i - 1].date), before: iso(bars[i].date), calendarDays: Math.round(d) });
  }
  return gaps;
}

/* ------------------------------------------------------------------ */
/* 1. RELIANCE.NS — 90 days of daily OHLCV                            */
/* ------------------------------------------------------------------ */
async function check1() {
  hr("1. RELIANCE.NS — 90d daily OHLCV");
  const from = daysAgo(90);
  const res = await chart("RELIANCE.NS", from);
  const bars = res.quotes as unknown as Bar[];

  const nullFields = { open: 0, high: 0, low: 0, close: 0, volume: 0, adjclose: 0 };
  let zeroVolume = 0;
  for (const b of bars) {
    for (const k of Object.keys(nullFields) as (keyof typeof nullFields)[]) {
      if (b[k] === null || b[k] === undefined) nullFields[k]++;
    }
    if (b.volume === 0) zeroVolume++;
  }
  const gaps = findGaps(bars);
  const expectedWeekdays = weekdaysBetween(from, new Date());

  log(`bars returned      : ${bars.length}`);
  log(`weekdays in window : ${expectedWeekdays} (holidays explain the difference)`);
  log(`first / last       : ${iso(bars[0].date)} → ${iso(bars[bars.length - 1].date)}`);
  log(`null fields        : ${JSON.stringify(nullFields)}`);
  log(`zero-volume bars   : ${zeroVolume}`);
  log(`gaps > 3 days      : ${gaps.length}`, gaps.length ? JSON.stringify(gaps) : "");
  log(`sample bar         : ${JSON.stringify(bars[bars.length - 1])}`);
  log(`meta.currency=${res.meta.currency} tz=${res.meta.exchangeTimezoneName} exch=${res.meta.exchangeName}`);

  report.check1 = {
    bars: bars.length, expectedWeekdays, first: iso(bars[0].date), last: iso(bars[bars.length - 1].date),
    nullFields, zeroVolume, gaps, meta: { currency: res.meta.currency, tz: res.meta.exchangeTimezoneName },
  };
  return bars;
}

/* ------------------------------------------------------------------ */
/* 2. ^NSEI — same window, alignment with the equity series           */
/* ------------------------------------------------------------------ */
async function check2(stockBars: Bar[]) {
  hr("2. ^NSEI (NIFTY 50) — alignment with RELIANCE.NS");
  const from = daysAgo(90);
  const res = await chart("^NSEI", from);
  const bars = res.quotes as unknown as Bar[];

  const sDates = new Set(stockBars.map((b) => iso(b.date)));
  const iDates = new Set(bars.map((b) => iso(b.date)));
  const onlyStock = [...sDates].filter((d) => !iDates.has(d));
  const onlyIndex = [...iDates].filter((d) => !sDates.has(d));
  const nullVolume = bars.filter((b) => b.volume === null || b.volume === undefined).length;
  const zeroVolume = bars.filter((b) => b.volume === 0).length;

  log(`index bars         : ${bars.length}  (stock bars: ${stockBars.length})`);
  log(`dates only in stock: ${onlyStock.length}`, onlyStock.slice(0, 5).join(", "));
  log(`dates only in index: ${onlyIndex.length}`, onlyIndex.slice(0, 5).join(", "));
  log(`index null volume  : ${nullVolume}   zero volume: ${zeroVolume}`);
  log(`sample bar         : ${JSON.stringify(bars[bars.length - 1])}`);

  report.check2 = { bars: bars.length, onlyStock, onlyIndex, nullVolume, zeroVolume };
  return bars;
}

/* ------------------------------------------------------------------ */
/* 3. Split adjustment correctness                                    */
/* ------------------------------------------------------------------ */
/**
 * Discover real splits rather than relying on memory, then verify two things:
 *   (a) is the returned `close` series already split-adjusted?
 *   (b) is the adjusted series continuous across the split date?
 * A correctly adjusted series shows a normal-sized daily return across the
 * split; an unadjusted one shows a jump of roughly the split ratio.
 */
async function check3() {
  hr("3. Split adjustment correctness");
  const candidates = [
    "RELIANCE.NS", "INFY.NS", "TCS.NS", "HDFCBANK.NS", "ITC.NS", "SBIN.NS",
    "IRCTC.NS", "BAJFINANCE.NS", "TATAMOTORS.NS", "WIPRO.NS", "TITAN.NS",
    "NESTLEIND.NS", "SIEMENS.NS", "TRENT.NS", "PERSISTENT.NS", "APLAPOLLO.NS",
  ];
  const from = daysAgo(365 * 4);
  const found: { symbol: string; date: string; ratio: number; numerator: number; denominator: number }[] = [];

  for (const sym of candidates) {
    try {
      const res = await chart(sym, from, { events: "div|split" });
      const splits = (res.events?.splits ?? []) as unknown as Record<string, {
        date: Date | number; numerator: number; denominator: number; splitRatio?: string;
      }>;
      for (const s of Object.values(splits)) {
        found.push({
          symbol: sym, date: iso(s.date as number),
          ratio: s.numerator / s.denominator,
          numerator: s.numerator, denominator: s.denominator,
        });
      }
    } catch (e) {
      log(`  ${sym}: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  found.sort((a, b) => (a.date < b.date ? 1 : -1));
  log(`splits discovered in last 4y across ${candidates.length} symbols: ${found.length}`);
  for (const f of found) log(`  ${f.symbol.padEnd(16)} ${f.date}  ${f.numerator}:${f.denominator} (ratio ${f.ratio})`);

  const verifications: unknown[] = [];
  for (const f of found.slice(0, 3)) {
    const d = new Date(f.date);
    const res = await chart(f.symbol, new Date(+d - 20 * 864e5), { period2: new Date(+d + 20 * 864e5), events: "div|split" });
    const bars = res.quotes as unknown as Bar[];
    const idx = bars.findIndex((b) => iso(b.date) >= f.date);
    if (idx < 1) { log(`  ${f.symbol}: could not locate split bar`); continue; }

    const prev = bars[idx - 1], on = bars[idx];
    const closeRet = (on.close! - prev.close!) / prev.close!;
    const adjRet = (on.adjclose! - prev.adjclose!) / prev.adjclose!;
    // If the series were unadjusted, we would see a return near (1/ratio - 1).
    const naiveExpected = 1 / f.ratio - 1;
    const closeIsAdjusted = Math.abs(closeRet - naiveExpected) > Math.abs(closeRet);
    const adjIsAdjusted = Math.abs(adjRet) < 0.25;
    const v = {
      symbol: f.symbol, splitDate: f.date, ratio: `${f.numerator}:${f.denominator}`,
      prevBar: { date: iso(prev.date), close: prev.close, adjclose: prev.adjclose },
      splitBar: { date: iso(on.date), close: on.close, adjclose: on.adjclose },
      returnOnCloseSeries: closeRet, returnOnAdjcloseSeries: adjRet,
      returnIfSeriesWereRaw: naiveExpected,
      closeSeriesAppearsSplitAdjusted: closeIsAdjusted,
      adjcloseSeriesContinuous: adjIsAdjusted,
      verdict: adjIsAdjusted ? "PASS — adjusted series is continuous across the split" : "FAIL — adjusted series jumps at the split",
    };
    verifications.push(v);
    log(`\n  ${f.symbol} ${f.date} ${f.numerator}:${f.denominator}`);
    log(`    ${iso(prev.date)}  close=${prev.close?.toFixed(2)}  adjclose=${prev.adjclose?.toFixed(2)}`);
    log(`    ${iso(on.date)}  close=${on.close?.toFixed(2)}  adjclose=${on.adjclose?.toFixed(2)}`);
    log(`    return on close series    : ${pct(closeRet)}`);
    log(`    return on adjclose series : ${pct(adjRet)}`);
    log(`    return if series were RAW : ${pct(naiveExpected)}`);
    log(`    → ${v.verdict}`);
  }

  report.check3 = { splitsFound: found, verifications };
}

/* ------------------------------------------------------------------ */
/* 4. NSE sector indices                                              */
/* ------------------------------------------------------------------ */
async function check4() {
  hr("4. NSE sector index resolution");
  const idx = [
    "^NSEI", "^NSEBANK", "^CNXIT", "^CNXAUTO", "^CNXPHARMA", "^CNXFMCG",
    "^CNXMETAL", "^CNXENERGY", "^CNXREALTY", "^CNXINFRA", "^CNXPSUBANK",
    "^CNXMEDIA", "^CNXFIN", "NIFTY_FIN_SERVICE.NS", "^CRSLDX", "^NSMIDCP",
  ];
  const results: { symbol: string; ok: boolean; bars?: number; last?: string; error?: string }[] = [];
  for (const s of idx) {
    try {
      const res = await chart(s, daysAgo(30));
      const bars = res.quotes as unknown as Bar[];
      results.push({ symbol: s, ok: bars.length > 0, bars: bars.length, last: bars.length ? iso(bars[bars.length - 1].date) : undefined });
      log(`  ✓ ${s.padEnd(24)} ${bars.length} bars, last ${bars.length ? iso(bars[bars.length - 1].date) : "-"}`);
    } catch (e) {
      results.push({ symbol: s, ok: false, error: (e as Error).message.slice(0, 120) });
      log(`  ✗ ${s.padEnd(24)} ${(e as Error).message.slice(0, 80)}`);
    }
  }
  report.check4 = results;
}

/* ------------------------------------------------------------------ */
/* 6. Live quote staleness metadata (run before the throttle test)    */
/* ------------------------------------------------------------------ */
async function check6() {
  hr("6. Live quote — staleness / freshness metadata");
  const q = (await yf.quote("RELIANCE.NS")) as unknown as Record<string, unknown>;
  const keys = Object.keys(q).sort();
  const freshness = [
    "regularMarketTime", "regularMarketPrice", "marketState", "exchangeTimezoneName",
    "exchangeTimezoneShortName", "exchangeDataDelayedBy", "quoteSourceName",
    "hasPrePostMarketData", "postMarketTime", "preMarketTime", "fullExchangeName",
    "priceHint", "sourceInterval", "triggerable", "currency",
  ];
  const picked: Record<string, unknown> = {};
  for (const k of freshness) if (k in q) picked[k] = q[k];

  const rmt = q.regularMarketTime as Date | number | undefined;
  const ageSec = rmt ? Math.round((Date.now() - +new Date(rmt as number)) / 1000) : null;

  log(`fields returned    : ${keys.length}`);
  for (const [k, v] of Object.entries(picked)) log(`  ${k.padEnd(26)} ${v instanceof Date ? v.toISOString() : String(v)}`);
  log(`\n  computed quote age: ${ageSec}s`);
  log(`  all keys: ${keys.join(", ")}`);

  report.check6 = { fieldCount: keys.length, freshnessFields: picked, computedAgeSeconds: ageSec, allKeys: keys };
}

/* ------------------------------------------------------------------ */
/* 5. Throttling — LAST, because it may poison the session            */
/* ------------------------------------------------------------------ */
async function check5() {
  hr("5. Throttling — 60 sequential quote requests, no delay");
  const universe = [
    "RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","SBIN.NS","BHARTIARTL.NS",
    "ITC.NS","LT.NS","KOTAKBANK.NS","AXISBANK.NS","HINDUNILVR.NS","BAJFINANCE.NS","MARUTI.NS",
    "SUNPHARMA.NS","TITAN.NS","ULTRACEMCO.NS","WIPRO.NS","NESTLEIND.NS","TATAMOTORS.NS",
  ];
  const results: { i: number; symbol: string; ok: boolean; ms: number; error?: string; status?: number }[] = [];
  const t0 = Date.now();
  let firstFailure: number | null = null;

  for (let i = 0; i < 60; i++) {
    const sym = universe[i % universe.length];
    const s = Date.now();
    try {
      await yf.quote(sym);
      results.push({ i, symbol: sym, ok: true, ms: Date.now() - s });
    } catch (e) {
      const err = e as Error & { response?: { status?: number }; name?: string };
      if (firstFailure === null) firstFailure = i;
      results.push({
        i, symbol: sym, ok: false, ms: Date.now() - s,
        error: `${err.name}: ${err.message}`.slice(0, 200),
        status: err.response?.status,
      });
    }
    if (i % 10 === 9) {
      const win = results.slice(i - 9, i + 1);
      log(`  req ${String(i - 9).padStart(2)}–${String(i).padStart(2)}: ${win.filter((r) => r.ok).length}/10 ok, avg ${Math.round(win.reduce((a, r) => a + r.ms, 0) / 10)}ms`);
    }
  }

  const failures = results.filter((r) => !r.ok);
  const totalMs = Date.now() - t0;
  log(`\n  total          : ${totalMs}ms for 60 requests (${Math.round(totalMs / 60)}ms avg, ${(60 / (totalMs / 1000)).toFixed(1)} req/s)`);
  log(`  succeeded      : ${results.filter((r) => r.ok).length}/60`);
  log(`  first failure  : ${firstFailure === null ? "none" : `request #${firstFailure}`}`);
  if (failures.length) {
    log(`  distinct errors:`);
    for (const m of new Set(failures.map((f) => f.error))) log(`    ${m}`);
  }

  report.check5 = {
    totalMs, requestsPerSecond: +(60 / (totalMs / 1000)).toFixed(2),
    succeeded: results.filter((r) => r.ok).length, failed: failures.length,
    firstFailureIndex: firstFailure,
    distinctErrors: [...new Set(failures.map((f) => f.error))],
    statuses: [...new Set(failures.map((f) => f.status))],
    slowestMs: Math.max(...results.map((r) => r.ms)),
  };
}

async function main() {
  const stockBars = await check1();
  await check2(stockBars);
  await check3();
  await check4();
  await check6();
  await check5(); // last: may leave us rate-limited
  writeFileSync("reports/phase0.json", JSON.stringify(report, null, 2));
  hr("Report written to reports/phase0.json");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
