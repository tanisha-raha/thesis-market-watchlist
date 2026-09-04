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
import { eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  changeEvents, corporateActions, ingestionBatches, priceBars, quoteObservations,
  quotes, symbols, symbolStats, watchlistItems,
} from "@/db/schema";
import { ingestQuotes, ingestHistory, refreshSymbolStats } from "@/lib/ingestion";
import { recordPollOutcome } from "@/lib/feed-health";
import { computeStats } from "@/lib/stats";
import { ReplayMarketDataProvider } from "@/lib/market/replay";
import { detectCorporateAction, isCandidate } from "@/lib/corporate-actions";
import { detectEvents, isMissedEvent } from "@/lib/change-engine";
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
  await db.delete(changeEvents).where(eq(changeEvents.symbol, SYM));
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

/* ------------------------------------------------------------------------- */
section("corporate-action guards (pure — protects a must-land Phase 4 input)");
{
  const span = (f: number, c: number) => [
    { date: "2026-08-03", first: f, current: c },
    { date: "2026-08-04", first: f * 1.1, current: c * 1.1 },
    { date: "2026-08-05", first: f * 1.2, current: c * 1.2 },
  ];

  const split = detectCorporateAction(SYM, span(200, 100));           // uniform 0.5
  check("a uniform, plausible 2:1 shift validates",
    split.status === "VALIDATED", `${split.status} — ${split.reason}`);

  const oneBar = detectCorporateAction(SYM, [
    { date: "2026-08-03", first: 200, current: 100 },
    { date: "2026-08-04", first: 220, current: 220 },
    { date: "2026-08-05", first: 240, current: 240 },
  ]);
  check("a single restated bar is rejected as non-uniform",
    oneBar.status === "REJECTED", `${oneBar.status} — ${oneBar.reason}`);

  const odd = detectCorporateAction(SYM, span(100, 137));             // uniform but implausible
  check("a uniform but implausible factor is rejected",
    odd.status === "REJECTED", `${odd.status} — ${odd.reason}`);

  const thin = detectCorporateAction(SYM, [{ date: "2026-08-03", first: 200, current: 100 }]);
  check("too few bars yields INSUFFICIENT rather than a verdict",
    thin.status === "INSUFFICIENT", thin.status);

  const a = detectCorporateAction(SYM, span(200, 100));
  const b = detectCorporateAction(SYM, span(200, 100.02));            // slightly different factor
  check("the fingerprint is stable across a slightly different factor",
    isCandidate(a) && isCandidate(b) && a.fingerprint === b.fingerprint);
}

/* ------------------------------------------------------------------------- */
section("transient resolution — the missed-event feature");
{
  const stats = {
    realizedVol20: 0.01, medianVolume20: 1000, ma20: 100, beta60: 1,
    high52w: 100, low52w: 80, high20: 100, low20: 90, sessionsUsed: 300,
  };
  const at = (h: number, m: number) => new Date(Date.UTC(2026, 7, 10, h, m));
  const obs = (pts: [number, number, number][]) => pts.map(([h, m, price]) => ({ at: at(h, m), price }));

  // Crosses the 52-week high, holds, then falls back through the re-arm band.
  const fireAndReverse = detectEvents({
    symbol: SYM, stats, dailyBars: [], benchmarkBars: [],
    observations: obs([[4, 0, 99], [5, 0, 105], [6, 0, 106], [7, 0, 99], [8, 0, 98]]),
  }).filter((e) => e.signalType === "cross_52w_high");

  check("a fire-and-reverse produces exactly one event", fireAndReverse.length === 1, `${fireAndReverse.length}`);
  check("occurredAt is when the condition became true",
    fireAndReverse[0]?.occurredAt.getTime() === at(5, 0).getTime(),
    fireAndReverse[0]?.occurredAt.toISOString());
  check("resolvedAt is when it stopped holding, not when it re-armed",
    fireAndReverse[0]?.resolvedAt?.getTime() === at(7, 0).getTime(),
    fireAndReverse[0]?.resolvedAt?.toISOString());
  check("it is a missed event for someone away across the whole span",
    isMissedEvent(fireAndReverse[0], at(4, 30), at(9, 0)));
  check("it is NOT a missed event for someone who was present when it fired",
    !isMissedEvent(fireAndReverse[0], at(6, 0), at(9, 0)));

  // The brief's oscillation case: 100.01 / 99.99 / 100.02 around the level.
  const oscillating = detectEvents({
    symbol: SYM, stats, dailyBars: [], benchmarkBars: [],
    observations: obs([
      [4, 0, 99], [4, 5, 100.01], [4, 10, 99.99], [4, 15, 100.02],
      [4, 20, 99.98], [4, 25, 100.03], [4, 30, 99.99],
    ]),
  }).filter((e) => e.signalType === "cross_52w_high");
  check("hysteresis: oscillating around the level fires once, not repeatedly",
    oscillating.length === 1, `${oscillating.length} events`);

  // A condition still holding at the end of the series must stay open.
  const stillOpen = detectEvents({
    symbol: SYM, stats, dailyBars: [], benchmarkBars: [],
    observations: obs([[4, 0, 99], [5, 0, 105], [6, 0, 106]]),
  }).filter((e) => e.signalType === "cross_52w_high");
  check("a condition that still holds has a null resolvedAt", stillOpen[0]?.resolvedAt === null);

  // Resolution must come from the intraday path. With no observations there is
  // nothing to resolve against, which is exactly the failure mode we are guarding
  // against: built on daily bars, this feature silently never fires.
  const dailyOnly = detectEvents({
    symbol: SYM, stats, observations: [], benchmarkBars: [],
    dailyBars: [bar("2026-08-10", 100), bar("2026-08-11", 106), bar("2026-08-12", 99)],
  }).filter((e) => e.signalType.startsWith("cross_"));
  check("without an intraday series no crossing is detected at all", dailyOnly.length === 0,
    `${dailyOnly.length} — daily bars alone cannot express a reversal`);
}

section("resolved events are immutable and never garbage-collected");
{
  await reset();
  const occurredAt = new Date("2026-08-10T06:25:00Z");
  const firstResolved = new Date("2026-08-10T08:45:00Z");
  const insert = async (resolvedAt: Date | null) => {
    const [batch] = await db.insert(ingestionBatches).values({ status: "STARTED", requestedCount: 1 }).returning();
    return db.insert(changeEvents).values({
      symbol: SYM, signalType: "cross_52w_high", window: "intraday",
      magnitude: "0.05", score: "5", occurredAt, resolvedAt,
      detectedAt: new Date(), ingestionBatchId: batch.id,
      explainJson: { signal: "cross_52w_high", price: 105, level: 100 },
    }).onConflictDoUpdate({
      target: [changeEvents.symbol, changeEvents.signalType, changeEvents.occurredAt],
      set: { resolvedAt: sql`coalesce(${changeEvents.resolvedAt}, excluded.resolved_at)` },
      setWhere: isNull(changeEvents.resolvedAt),
    });
  };

  await insert(null);
  let row = (await db.select().from(changeEvents).where(eq(changeEvents.symbol, SYM)))[0];
  check("an unresolved event is stored open", row.resolvedAt === null);

  await insert(firstResolved);
  row = (await db.select().from(changeEvents).where(eq(changeEvents.symbol, SYM)))[0];
  check("re-detection sets resolvedAt once", row.resolvedAt?.getTime() === firstResolved.getTime());

  await insert(new Date("2026-08-11T10:00:00Z"));
  row = (await db.select().from(changeEvents).where(eq(changeEvents.symbol, SYM)))[0];
  check("a later run cannot move resolvedAt", row.resolvedAt?.getTime() === firstResolved.getTime(),
    row.resolvedAt?.toISOString());

  await insert(null);
  row = (await db.select().from(changeEvents).where(eq(changeEvents.symbol, SYM)))[0];
  check("a later run cannot clear resolvedAt back to null", row.resolvedAt?.getTime() === firstResolved.getTime());

  const count = await db.select({ n: sql<number>`count(*)::int` }).from(changeEvents).where(eq(changeEvents.symbol, SYM));
  check("re-detection never duplicates the event", count[0].n === 1, `${count[0].n} row(s)`);
  // jsonb normalises key order, so compare values rather than serialised text.
  const explain = row.explainJson as Record<string, unknown>;
  check("explain_json is unchanged by re-detection",
    explain.signal === "cross_52w_high" && explain.price === 105 && explain.level === 100
      && Object.keys(explain).length === 3,
    JSON.stringify(explain));
}

await reset();
await db.delete(symbols).where(eq(symbols.symbol, SYM));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
