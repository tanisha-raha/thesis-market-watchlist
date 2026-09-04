/**
 * Fetches ~2 years of daily bars for the universe into a committed seed file.
 *
 * Two years because 52-week levels need 252 trading sessions and a 60-day beta
 * needs headroom beyond that. Always a long window: Phase 0 found short windows
 * return a single bar for several NSE indices with no error at all.
 *
 * Same rationale as the 5m seed — the deployed app must never cold-backfill.
 * Resumable. Run: npm run seed:daily
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import YahooFinance from "yahoo-finance2";
import { FULL_UNIVERSE } from "../lib/universe";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const OUT = "seed/daily.ndjson";
const DAYS = 730;

/** [YYYY-MM-DD, open, high, low, close, adjClose, volume] */
type Row = [string, number | null, number | null, number | null, number | null, number | null, number | null];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const istDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
});

function alreadyFetched(): Set<string> {
  if (!existsSync(OUT)) return new Set();
  const done = new Set<string>();
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).symbol); } catch { /* truncated final line */ }
  }
  return done;
}

async function fetchOne(symbol: string, attempt = 1): Promise<Row[]> {
  try {
    const res = await yf.chart(symbol, {
      period1: new Date(Date.now() - DAYS * 864e5),
      interval: "1d",
    });
    return (res.quotes as unknown as {
      date: Date; open: number | null; high: number | null; low: number | null;
      close: number | null; volume: number | null; adjclose?: number | null;
    }[]).map((b) => [
      istDate.format(new Date(b.date)),
      b.open, b.high, b.low, b.close, b.adjclose ?? null, b.volume,
    ]);
  } catch (err) {
    if (attempt >= 4) throw err;
    const wait = 2 ** attempt * 1000 + Math.random() * 1000;
    await sleep(wait);
    return fetchOne(symbol, attempt + 1);
  }
}

const done = alreadyFetched();
const todo = FULL_UNIVERSE.filter((s) => !done.has(s));
console.log(`universe ${FULL_UNIVERSE.length} · already fetched ${done.size} · to fetch ${todo.length}`);

let total = 0;
const failures: string[] = [];
for (const [i, symbol] of todo.entries()) {
  try {
    const rows = await fetchOne(symbol);
    appendFileSync(OUT, JSON.stringify({ symbol, interval: "1d", rows }) + "\n");
    total += rows.length;
    console.log(`  [${i + 1}/${todo.length}] ${symbol.padEnd(16)} ${String(rows.length).padStart(4)} bars  ${rows[0]?.[0]} → ${rows.at(-1)?.[0]}`);
  } catch (err) {
    failures.push(symbol);
    console.log(`  [${i + 1}/${todo.length}] ${symbol.padEnd(16)} FAILED — ${(err as Error).message.slice(0, 70)}`);
  }
  await sleep(250 + Math.random() * 350);
}

console.log(`\n${total} bars written to ${OUT}`);
if (failures.length) { console.log(`${failures.length} failed: ${failures.join(", ")}`); process.exit(1); }
