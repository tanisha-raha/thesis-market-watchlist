/**
 * Fetches 5-minute bars for the universe and writes them to a committed seed file.
 *
 * WHY THIS IS URGENT AND RUN LOCALLY
 * Yahoo serves 5m bars for roughly 60 days and 1m for about 8 (Phase 0). That
 * window slides: history not captured today is gone permanently. And the
 * deployed app must never cold-backfill — Yahoo throttles datacenter IPs harder
 * than residential ones — so the fetch happens here and the result ships as a
 * file that `seed-load.ts` reads at deploy time.
 *
 * WHAT IT CAPTURES
 * Full OHLCV per bar, even though the loader only uses the close. The fetch is
 * irreversible and the load is not, so we capture everything available now and
 * decide later what to use.
 *
 * Resumable: rerunning skips symbols already in the output file.
 *
 * Run: npm run seed:intraday
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import YahooFinance from "yahoo-finance2";
import { FULL_UNIVERSE } from "../lib/universe";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });
const OUT = "seed/intraday-5m.ndjson";
const DAYS = 60;

/** [epochSeconds, open, high, low, close, volume] — compact on purpose; this file is committed. */
type Row = [number, number | null, number | null, number | null, number | null, number | null];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      interval: "5m",
    });
    return (res.quotes as unknown as {
      date: Date; open: number | null; high: number | null;
      low: number | null; close: number | null; volume: number | null;
    }[]).map((b) => [
      Math.floor(new Date(b.date).getTime() / 1000),
      b.open, b.high, b.low, b.close, b.volume,
    ]);
  } catch (err) {
    if (attempt >= 4) throw err;
    // Exponential backoff with jitter. Phase 0 never provoked a rate limit from
    // this IP, but "never observed" is not "cannot happen" and a 50-symbol
    // sequential fetch is the heaviest thing we ask of the feed.
    const wait = 2 ** attempt * 1000 + Math.random() * 1000;
    console.log(`    retry ${attempt} for ${symbol} in ${Math.round(wait)}ms — ${(err as Error).message.slice(0, 70)}`);
    await sleep(wait);
    return fetchOne(symbol, attempt + 1);
  }
}

const done = alreadyFetched();
const todo = FULL_UNIVERSE.filter((s) => !done.has(s));
console.log(`universe ${FULL_UNIVERSE.length} · already fetched ${done.size} · to fetch ${todo.length}`);

let totalBars = 0;
const failures: string[] = [];

for (const [i, symbol] of todo.entries()) {
  try {
    const rows = await fetchOne(symbol);
    appendFileSync(OUT, JSON.stringify({ symbol, interval: "5m", rows }) + "\n");
    totalBars += rows.length;
    const span = rows.length
      ? `${new Date(rows[0][0] * 1000).toISOString().slice(0, 10)} → ${new Date(rows.at(-1)![0] * 1000).toISOString().slice(0, 10)}`
      : "empty";
    console.log(`  [${i + 1}/${todo.length}] ${symbol.padEnd(16)} ${String(rows.length).padStart(5)} bars  ${span}`);
  } catch (err) {
    failures.push(symbol);
    console.log(`  [${i + 1}/${todo.length}] ${symbol.padEnd(16)} FAILED — ${(err as Error).message.slice(0, 80)}`);
  }
  // Jittered spacing between symbols, for the same reason as the backoff.
  await sleep(300 + Math.random() * 400);
}

console.log(`\n${totalBars} bars written to ${OUT}`);
if (failures.length) {
  console.log(`${failures.length} failed: ${failures.join(", ")} — rerun to retry (resumable)`);
  process.exit(1);
}
