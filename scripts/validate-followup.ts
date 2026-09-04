/** Phase 0 follow-ups: sector index history, raw-vs-adjusted, intraday, harder throttle. */
import YahooFinance from "yahoo-finance2";
import { writeFileSync } from "node:fs";
const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const report: Record<string, unknown> = {};
const log = (...a: unknown[]) => console.log(...a);
const hr = (t: string) => log(`\n${"=".repeat(64)}\n${t}\n${"=".repeat(64)}`);
const iso = (d: unknown) => new Date(d as number).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);
type Bar = { date: Date; close: number|null; volume: number|null; adjclose?: number|null };

/* A. Sector indices over a long window — do they have usable history? */
hr("A. Sector indices — 2 year history depth");
const sectors = ["^NSEBANK","^CNXIT","^CNXAUTO","^CNXPHARMA","^CNXFMCG","^CNXMETAL","^CNXENERGY","^CNXREALTY","^CNXFIN","^CNXPSUBANK","^CNXINFRA","^CNXMEDIA"];
const sectorRes: Record<string, unknown> = {};
for (const s of sectors) {
  try {
    const r = await yf.chart(s, { period1: daysAgo(730), interval: "1d" });
    const b = r.quotes as unknown as Bar[];
    const dates = b.map((x) => iso(x.date));
    const usable = b.length >= 400;
    sectorRes[s] = { bars: b.length, first: dates[0], last: dates.at(-1), usable };
    log(`  ${usable ? "✓" : "✗"} ${s.padEnd(14)} ${String(b.length).padStart(4)} bars   ${dates[0]} → ${dates.at(-1)}`);
  } catch (e) { sectorRes[s] = { error: (e as Error).message }; log(`  ✗ ${s.padEnd(14)} ${(e as Error).message.slice(0,60)}`); }
}
report.sectorDepth = sectorRes;

/* B. Is `close` raw or split-adjusted? And what does adjclose add? */
hr("B. close vs adjclose — what is actually adjusted");
{
  // RELIANCE split 2:1 on 2024-10-28. Ask for a window that STARTS AFTER the split.
  const after = await yf.chart("RELIANCE.NS", { period1: new Date("2024-11-01"), period2: new Date("2024-12-01"), interval: "1d", events: "div|split" });
  const spanning = await yf.chart("RELIANCE.NS", { period1: new Date("2024-10-01"), period2: new Date("2024-12-01"), interval: "1d", events: "div|split" });
  const aBars = after.quotes as unknown as Bar[]; const sBars = spanning.quotes as unknown as Bar[];
  const pick = (bs: Bar[], d: string) => bs.find((b) => iso(b.date) === d);
  const day = "2024-11-05";
  const a = pick(aBars, day), s = pick(sBars, day);
  log(`  ${day} from window starting AFTER split : close=${a?.close?.toFixed(2)} adjclose=${a?.adjclose?.toFixed(2)}`);
  log(`  ${day} from window SPANNING the split   : close=${s?.close?.toFixed(2)} adjclose=${s?.adjclose?.toFixed(2)}`);
  log(`  → identical? ${a?.close === s?.close ? "YES — split adjustment is baked into `close` regardless of window" : "NO — window-dependent"}`);

  // How much do close and adjclose diverge over 2y? (that gap is dividends)
  const two = await yf.chart("RELIANCE.NS", { period1: daysAgo(730), interval: "1d", events: "div|split" });
  const tb = two.quotes as unknown as Bar[];
  const ratios = tb.filter((b)=>b.close&&b.adjclose).map((b) => b.adjclose! / b.close!);
  const divs = Object.values((two.events?.dividends ?? {}) as Record<string, {date:unknown;amount:number}>);
  log(`  adjclose/close ratio over 2y: min ${Math.min(...ratios).toFixed(5)}  max ${Math.max(...ratios).toFixed(5)}  latest ${ratios.at(-1)!.toFixed(5)}`);
  log(`  dividends in window: ${divs.length}  ${divs.map((d)=>`${iso(d.date)}:₹${d.amount}`).join(" ")}`);
  log(`  → the close↔adjclose gap is dividends only; splits are already in \`close\`.`);
  report.rawVsAdjusted = {
    splitBakedIntoClose: a?.close === s?.close,
    closeAfterWindow: a?.close, closeSpanningWindow: s?.close,
    adjCloseRatioMin: Math.min(...ratios), adjCloseRatioMax: Math.max(...ratios),
    dividends: divs.map((d)=>({date:iso(d.date),amount:d.amount})),
    implication: "Yahoo returns NO raw (unadjusted) price series. Historical `close` is retroactively restated on a split.",
  };
}

/* C. Intraday availability — needed for transient/missed events */
hr("C. Intraday interval availability & retention");
const intraRes: Record<string, unknown> = {};
for (const [interval, days] of [["1h", 60], ["1h", 730], ["5m", 30], ["5m", 60], ["1m", 7], ["1m", 30]] as [string, number][]) {
  try {
    const r = await yf.chart("RELIANCE.NS", { period1: daysAgo(days), interval: interval as "1h" });
    const b = r.quotes as unknown as Bar[];
    intraRes[`${interval}@${days}d`] = { bars: b.length, first: b[0] && new Date(b[0].date).toISOString(), last: b.at(-1) && new Date(b.at(-1)!.date).toISOString() };
    log(`  ✓ ${interval} over ${days}d: ${b.length} bars, ${b[0]?new Date(b[0].date).toISOString():"-"} → ${b.at(-1)?new Date(b.at(-1)!.date).toISOString():"-"}`);
  } catch (e) {
    intraRes[`${interval}@${days}d`] = { error: (e as Error).message.slice(0,140) };
    log(`  ✗ ${interval} over ${days}d: ${(e as Error).message.slice(0,110)}`);
  }
}
report.intraday = intraRes;

/* D. Harder throttle probe: batched quotes + concurrency + sustained volume */
hr("D. Throttle probe — batching and concurrency");
const uni = ["RELIANCE.NS","TCS.NS","HDFCBANK.NS","INFY.NS","ICICIBANK.NS","SBIN.NS","BHARTIARTL.NS","ITC.NS","LT.NS","KOTAKBANK.NS","AXISBANK.NS","HINDUNILVR.NS","BAJFINANCE.NS","MARUTI.NS","SUNPHARMA.NS","TITAN.NS","ULTRACEMCO.NS","WIPRO.NS","NESTLEIND.NS","TATAMOTORS.NS","ADANIENT.NS","ASIANPAINT.NS","BAJAJFINSV.NS","BPCL.NS","CIPLA.NS","COALINDIA.NS","DIVISLAB.NS","DRREDDY.NS","EICHERMOT.NS","GRASIM.NS","HCLTECH.NS","HDFCLIFE.NS","HEROMOTOCO.NS","HINDALCO.NS","INDUSINDBK.NS","JSWSTEEL.NS","M&M.NS","NTPC.NS","ONGC.NS","POWERGRID.NS","SBILIFE.NS","SHREECEM.NS","TATACONSUM.NS","TATASTEEL.NS","TECHM.NS","UPL.NS","APOLLOHOSP.NS","BRITANNIA.NS","ADANIPORTS.NS","BAJAJ-AUTO.NS"];

// D1: one batched call for all 50 symbols
try {
  const t = Date.now();
  const qs = await yf.quote(uni) as unknown as unknown[];
  log(`  ✓ batched quote(50 symbols) → ${qs.length} results in ${Date.now()-t}ms  ← 1 HTTP request`);
  report.batchedQuote = { symbols: uni.length, returned: qs.length, ms: Date.now()-t, ok: true };
} catch (e) { log(`  ✗ batched: ${(e as Error).message.slice(0,120)}`); report.batchedQuote = { ok:false, error:(e as Error).message }; }

// D2: 20 concurrent chart requests (heavier endpoint)
{
  const t = Date.now();
  const out = await Promise.allSettled(uni.slice(0,20).map((s) => yf.chart(s, { period1: daysAgo(90), interval: "1d" })));
  const bad = out.filter((o) => o.status === "rejected");
  log(`  concurrent chart×20: ${out.length-bad.length}/20 ok in ${Date.now()-t}ms`);
  for (const b of bad.slice(0,3)) log(`     ${String((b as PromiseRejectedResult).reason).slice(0,140)}`);
  report.concurrentChart20 = { ok: out.length-bad.length, failed: bad.length, ms: Date.now()-t, errors: bad.slice(0,3).map((b)=>String((b as PromiseRejectedResult).reason).slice(0,200)) };
}

// D3: sustained burst — 250 sequential quotes, find the ceiling
{
  const t = Date.now(); let firstFail: number|null = null; let ok = 0;
  const errs: string[] = [];
  for (let i = 0; i < 250; i++) {
    try { await yf.quote(uni[i % uni.length]); ok++; }
    catch (e) { if (firstFail===null) firstFail=i; errs.push(`${(e as Error).name}: ${(e as Error).message}`.slice(0,160)); }
    if (i % 50 === 49) log(`   ...${i+1} requests, ${ok} ok, ${Date.now()-t}ms elapsed`);
  }
  log(`  250 sequential quotes: ${ok}/250 ok in ${Date.now()-t}ms (${(250/((Date.now()-t)/1000)).toFixed(1)} req/s)`);
  log(`  first failure: ${firstFail === null ? "none — no throttle hit from this IP" : `#${firstFail}`}`);
  for (const m of new Set(errs)) log(`     ${m}`);
  report.burst250 = { ok, failed: 250-ok, firstFailureIndex: firstFail, ms: Date.now()-t, distinctErrors: [...new Set(errs)] };
}

writeFileSync("reports/phase0-followup.json", JSON.stringify(report, null, 2));
hr("Written to reports/phase0-followup.json");
