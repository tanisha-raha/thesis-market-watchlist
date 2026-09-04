/**
 * The five integration tests.
 *
 * Deliberately five, not fifty. Each one protects a promise the product makes to
 * a user or a reviewer; anything a manual check can cover is logged in
 * DECISIONS.md instead. With the thesis engine still unwritten, test count is
 * not where the remaining hours should go.
 *
 * Run: npm test
 */
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  corporateActions, ingestionBatches, priceBars, quoteObservations, quotes,
  symbols, symbolStats, watchlistItems,
} from "@/db/schema";
import { ingestQuotes, ingestHistory, refreshSymbolStats } from "@/lib/ingestion";
import { recordPollOutcome } from "@/lib/feed-health";
import { computeStats } from "@/lib/stats";
import { ReplayMarketDataProvider } from "@/lib/market/replay";
import type { Bar, Quote } from "@/lib/market/types";

let passed = 0;
let failed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  cond ? passed++ : failed++;
};
const section = (t: string) => console.log(`\n${t}`);

const SYM = "TEST-INGEST.NS";
const quote = (price: number, asOf: Date): Quote => ({
  symbol: SYM, price, previousClose: price - 1, asOf,
  marketState: "REGULAR", currency: "INR", name: "Test", exchange: "NSE",
});
const bar = (date: string, close: number, volume = 1000): Bar => ({
  date, open: close, high: close, low: close, close, volume, adjClose: close,
});

/** Removes every trace of the fixture symbol so the suite is rerunnable. */
async function reset() {
  await db.delete(quoteObservations).where(eq(quoteObservations.symbol, SYM));
  await db.delete(priceBars).where(eq(priceBars.symbol, SYM));
  await db.delete(symbolStats).where(eq(symbolStats.symbol, SYM));
  await db.delete(corporateActions).where(eq(corporateActions.symbol, SYM));
  await db.delete(quotes).where(eq(quotes.symbol, SYM));
  await db.delete(watchlistItems).where(eq(watchlistItems.symbol, SYM));
  await db.delete(symbols).where(eq(symbols.symbol, SYM));
  await db.insert(symbols).values({ symbol: SYM, name: "Test" });
}

await reset();

/* ------------------------------------------------------------------------- */
section("1. a failed or incomplete poll preserves last-known-good");
{
  const good = new Date("2026-09-04T06:00:00Z");
  await ingestQuotes(new ReplayMarketDataProvider({ quotes: { [SYM]: quote(100, good) } }), [SYM]);

  const before = (await db.select().from(quotes).where(eq(quotes.symbol, SYM)))[0];
  check("a good poll stores a quote", before != null && Number(before.price) === 100);

  // A total feed outage.
  let threw = false;
  try {
    await ingestQuotes(new ReplayMarketDataProvider({ failOn: new Error("feed down") }), [SYM]);
  } catch { threw = true; }
  check("a feed outage surfaces as an error", threw);

  const afterOutage = (await db.select().from(quotes).where(eq(quotes.symbol, SYM)))[0];
  check("last-known-good survives the outage",
    Number(afterOutage.price) === 100 && afterOutage.asOf.getTime() === good.getTime(),
    `₹${afterOutage.price} as of ${afterOutage.asOf.toISOString()}`);

  // A batch that silently drops the symbol, which is Yahoo's real behaviour.
  const res = await ingestQuotes(new ReplayMarketDataProvider({ quotes: {} }), [SYM]);
  check("a silently dropped symbol is reported as missing", res.missing.includes(SYM));

  const afterMissing = (await db.select().from(quotes).where(eq(quotes.symbol, SYM)))[0];
  check("last-known-good survives a missing symbol", Number(afterMissing.price) === 100);

  const sym = (await db.select().from(symbols).where(eq(symbols.symbol, SYM)))[0];
  check("the miss is counted but stays below the user-visible threshold",
    sym.consecutiveFeedMisses === 1, `misses=${sym.consecutiveFeedMisses}`);
}

/* ------------------------------------------------------------------------- */
section("2. first-observed history is immutable under provider restatement");
{
  await reset();
  const before = new ReplayMarketDataProvider({
    bars: { [SYM]: [bar("2026-08-03", 200), bar("2026-08-04", 210), bar("2026-08-05", 220)] },
  });
  await ingestHistory(before, SYM, 400);

  // The provider halves its history, exactly as Yahoo does after a 2:1 split.
  const after = new ReplayMarketDataProvider({
    bars: { [SYM]: [bar("2026-08-03", 100), bar("2026-08-04", 105), bar("2026-08-05", 110)] },
  });
  await ingestHistory(after, SYM, 400);

  const rows = await db.select().from(priceBars).where(eq(priceBars.symbol, SYM)).orderBy(priceBars.tradingDate);
  check("first-observed close is unchanged",
    rows.every((r, i) => Number(r.firstObservedClose) === [200, 210, 220][i]),
    rows.map((r) => r.firstObservedClose).join(", "));
  check("current provider close reflects the restatement",
    rows.every((r, i) => Number(r.currentProviderClose) === [100, 105, 110][i]),
    rows.map((r) => r.currentProviderClose).join(", "));
  check("the divergence recovers the split factor",
    Number(rows[0].currentProviderClose) / Number(rows[0].firstObservedClose) === 0.5,
    `factor = ${Number(rows[0].currentProviderClose) / Number(rows[0].firstObservedClose)}`);
}

/* ------------------------------------------------------------------------- */
section("3. historical ingestion is idempotent");
{
  await reset();
  const bars = [bar("2026-08-03", 100), bar("2026-08-04", 101), bar("2026-08-05", 102)];
  const provider = new ReplayMarketDataProvider({ bars: { [SYM]: bars } });

  await ingestHistory(provider, SYM, 400);
  const first = await db.select({ n: sql<number>`count(*)::int` }).from(priceBars).where(eq(priceBars.symbol, SYM));

  await ingestHistory(provider, SYM, 400);
  await ingestHistory(provider, SYM, 400);
  const third = await db.select({ n: sql<number>`count(*)::int` }).from(priceBars).where(eq(priceBars.symbol, SYM));

  check("three identical ingests produce one row per bar",
    first[0].n === bars.length && third[0].n === bars.length, `${first[0].n} then ${third[0].n}`);

  // The observation path must be idempotent too, or a repeated poll inflates the
  // price history that the missed-event detector reads.
  const asOf = new Date("2026-09-04T06:05:00Z");
  const qp = new ReplayMarketDataProvider({ quotes: { [SYM]: quote(100, asOf) } });
  await ingestQuotes(qp, [SYM]);
  await ingestQuotes(qp, [SYM]);
  const obs = await db.select({ n: sql<number>`count(*)::int` }).from(quoteObservations).where(eq(quoteObservations.symbol, SYM));
  check("re-polling the same exchange timestamp adds one observation", obs[0].n === 1, `${obs[0].n} rows`);
}

/* ------------------------------------------------------------------------- */
section("4. stats never emit NaN or Infinity");
{
  const flat = Array.from({ length: 300 }, (_, i) => bar(`2026-01-${String((i % 28) + 1).padStart(2, "0")}`, 100));
  const cases: [string, Bar[], Bar[]][] = [
    ["empty input", [], []],
    ["a single bar", [bar("2026-01-01", 100)], [bar("2026-01-01", 100)]],
    ["all volumes zero (a market holiday)", [bar("2026-01-01", 100, 0), bar("2026-01-02", 101, 0)], []],
    ["null closes", [{ ...bar("2026-01-01", 0), close: null, adjClose: null }], []],
    ["a zero price", [bar("2026-01-01", 0), bar("2026-01-02", 100)], []],
    ["a negative price", [bar("2026-01-01", -5), bar("2026-01-02", 100)], []],
    ["a perfectly flat benchmark", flat, flat],
    ["no overlapping dates with the benchmark",
      [bar("2026-01-01", 100), bar("2026-01-02", 110)],
      [bar("2025-01-01", 100), bar("2025-01-02", 110)]],
  ];

  let allClean = true;
  for (const [label, bars, bench] of cases) {
    const stats = computeStats(bars, bench);
    const bad = Object.entries(stats).filter(([, v]) => typeof v === "number" && !Number.isFinite(v));
    if (bad.length) { allClean = false; check(`  ${label}`, false, JSON.stringify(bad)); }
  }
  check("every pathological input yields finite-or-null stats", allClean, `${cases.length} cases`);

  // And the real thing still produces sane numbers.
  const real = computeStats(
    Array.from({ length: 300 }, (_, i) => bar(`2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, 100 + Math.sin(i) * 5)),
    Array.from({ length: 300 }, (_, i) => bar(`2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, 200 + Math.cos(i) * 3)),
  );
  check("52-week levels are populated on a real series",
    real.high52w != null && real.low52w != null && real.high52w >= real.low52w,
    `high ${real.high52w?.toFixed(2)} / low ${real.low52w?.toFixed(2)}`);
}

/* ------------------------------------------------------------------------- */
section("5. rollback removes every partial write, feed-health included");
{
  await reset();
  await db.update(symbols).set({ consecutiveFeedMisses: 0 }).where(eq(symbols.symbol, SYM));

  const missesBefore = (await db.select().from(symbols).where(eq(symbols.symbol, SYM)))[0].consecutiveFeedMisses;
  const batchesBefore = (await db.select({ n: sql<number>`count(*)::int` }).from(ingestionBatches))[0].n;

  // The invariant under test: a helper called inside a transaction must write
  // THROUGH that transaction. Before `recordPollOutcome` took an executor it
  // closed over the pooled `db`, so this counter survived the rollback — the
  // transaction looked correct and silently was not.
  try {
    await db.transaction(async (tx) => {
      await tx.insert(ingestionBatches).values({ status: "STARTED", requestedCount: 1 });
      await recordPollOutcome(tx, [], [SYM]);
      throw new Error("forced rollback");
    });
  } catch { /* expected */ }

  const missesAfter = (await db.select().from(symbols).where(eq(symbols.symbol, SYM)))[0].consecutiveFeedMisses;
  const batchesAfter = (await db.select({ n: sql<number>`count(*)::int` }).from(ingestionBatches))[0].n;

  check("feed-health writes roll back with the transaction",
    missesAfter === missesBefore, `misses ${missesBefore} -> ${missesAfter}`);
  check("the batch row rolls back too", batchesAfter === batchesBefore, `${batchesBefore} -> ${batchesAfter}`);

  // And end to end: a mid-transaction failure leaves no partial ingestion state.
  const obsBefore = (await db.select({ n: sql<number>`count(*)::int` }).from(quoteObservations).where(eq(quoteObservations.symbol, SYM)))[0].n;
  const bad = new ReplayMarketDataProvider({
    quotes: {
      [SYM]: quote(100, new Date("2026-09-04T07:00:00Z")),
      // No such row in `symbols`, so the insert violates a foreign key mid-transaction.
      "GHOST-NOT-IN-SYMBOLS.NS": {
        ...quote(50, new Date("2026-09-04T07:00:00Z")), symbol: "GHOST-NOT-IN-SYMBOLS.NS",
      },
    },
  });
  let ingestThrew = false;
  try { await ingestQuotes(bad, [SYM, "GHOST-NOT-IN-SYMBOLS.NS"]); } catch { ingestThrew = true; }
  const obsAfter = (await db.select({ n: sql<number>`count(*)::int` }).from(quoteObservations).where(eq(quoteObservations.symbol, SYM)))[0].n;

  check("a mid-transaction failure aborts the ingest", ingestThrew);
  check("no observations were partially written", obsAfter === obsBefore, `${obsBefore} -> ${obsAfter}`);

  const failedBatch = (await db.select().from(ingestionBatches).orderBy(sql`id desc`).limit(1))[0];
  check("the batch is recorded as FAILED, not COMPLETED", failedBatch.status === "FAILED", failedBatch.status);
}

await reset();
await db.delete(symbols).where(eq(symbols.symbol, SYM));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
