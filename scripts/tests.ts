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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  changeEvents, corporateActions, ingestionBatches, priceBars, quoteObservations,
  quotes, symbols, symbolStats, theses, userSymbolReadState, users, watchlistItems,
} from "@/db/schema";
import { ingestQuotes, ingestHistory, refreshSymbolStats } from "@/lib/ingestion";
import { recordPollOutcome } from "@/lib/feed-health";
import { computeStats } from "@/lib/stats";
import { ReplayMarketDataProvider } from "@/lib/market/replay";
import { detectCorporateAction, isCandidate } from "@/lib/corporate-actions";
import { detectEvents, isMissedEvent } from "@/lib/change-engine";
import { evaluateThesis, resolveState } from "@/lib/thesis-engine";
import { applyCorporateActions } from "@/lib/thesis";
import { advanceDigestWatermark, advanceWatermark } from "@/lib/digest";
import { answerFromContext, getAskContext, type AskContext } from "@/lib/ask-thesis";
import { getPresentationData, getStoredEvidence } from "@/lib/presentation";
import { feedDisplay, formatPrice } from "@/components/ui";
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

section("Presentation — truthful feed states");
{
  const now = new Date();
  check("regular quote never claims unverified live freshness", feedDisplay(now, "REGULAR").label === "DELAYED");
  check("recent closed quote is labeled market closed", feedDisplay(now, "CLOSED").label === "MARKET CLOSED");
  check("old closing quote cannot hide a stale feed", feedDisplay(new Date(now.getTime() - 48 * 3600_000), "CLOSED").label === "STALE");
  check("degraded provider preserves last-known exchange timestamp", feedDisplay(now, "CLOSED", "degraded").label === "DEGRADED" && feedDisplay(now, "CLOSED", "degraded").asOf === now);
  check("missing quote and explicit demo context remain distinct", feedDisplay(null, null).label === "AWAITING DATA" && feedDisplay(now, "CLOSED", "ok", true).label === "DEMO REPLAY");
  check("missing and non-finite prices never become fabricated values", [null, NaN, Infinity].every((value) => formatPrice(value) === "—"));
}

/* ------------------------------------------------------------------------- */
section("Ask THESIS — bounded explanation layer");
{
  const context = {
    mode: "LIVE",
    currentSymbol: "INFY.NS",
    watchlist: [{ symbol: "INFY.NS", name: "Infosys", price: 1100, previousClose: 1080, asOf: new Date("2026-09-04T06:00:00Z"), marketState: "REGULAR", addedAt: new Date(), thesisState: "WATCHING", health: "healthy" }],
    theses: [{ symbol: "INFY.NS", type: "price_range", state: "WATCHING", note: "Watch the range", params: { low: 1000, high: 1100 } }],
    digest: { awayFrom: null, cutoff: new Date(), sessionsInWindow: 1, marketClosedThroughout: false, contradictions: [], triggers: [{ symbol: "INFY.NS" }], missed: [], anomalies: [], unchanged: [] },
    recentEvents: [{ symbol: "INFY.NS", signalType: "large_move", occurredAt: new Date("2026-09-04T06:00:00Z"), resolvedAt: null, evidence: [{ label: "Move", value: "2.3σ", basis: "vs 20-day realized volatility" }] }],
    lastCompletedBatchAt: new Date("2026-09-04T06:05:00Z"),
  } as unknown as AskContext;
  const thesisReply = answerFromContext("What is my thesis for INFY?", context);
  check("symbol context selects only the current watched symbol", thesisReply.answer.includes("INFY.NS") && thesisReply.answer.includes("₹1,000.00 to ₹1,100.00"));
  check("thesis context explains recorded state rather than deciding it", thesisReply.answer.includes("deterministic state is watching"));
  check("digest context reports committed digest output", answerFromContext("What changed while I was away?", context).answer.includes("condition triggered"));
  check("event context repeats stored evidence", answerFromContext("Why is this event significant?", context).answer.includes("2.3σ"));
  check("evidence wording selects recorded event evidence", answerFromContext("Explain the latest INFY evidence", context).answer.includes("2.3σ"));
  check("advisory questions are declined", answerFromContext("Should I buy INFY?", context).answer.includes("can’t recommend"));
  check("missing non-watched symbol has no user-scoped context", answerFromContext("What is my thesis for TCS.NS?", context).answer.includes("not on your watchlist"));
  const demoReply = answerFromContext("Is this live data or demo replay?", { ...context, mode: "DEMO REPLAY" });
  check("demo replay is labelled explicitly", demoReply.answer.includes("DEMO REPLAY"));
  // There is no required AI provider: the deterministic answer builder stays
  // available when an optional presentation provider is absent or unavailable.
  check("optional AI absence leaves the explanation layer available", answerFromContext("What does sigma mean?", context).answer.includes("sigma"));

  const suffix = Date.now();
  const otherSymbol = `ASK-OTHER-${suffix}.NS`;
  const [firstUser] = await db.insert(users).values({ email: `ask-first-${suffix}@example.com`, passwordHash: "test" }).returning();
  const [secondUser] = await db.insert(users).values({ email: `ask-second-${suffix}@example.com`, passwordHash: "test" }).returning();
  await db.insert(symbols).values({ symbol: otherSymbol, name: "Other user only" });
  await db.insert(watchlistItems).values([{ userId: firstUser.id, symbol: SYM }, { userId: secondUser.id, symbol: otherSymbol }]);
  const scoped = await getAskContext(firstUser.id);
  check("database context is scoped to the authenticated user", scoped.watchlist.length === 1 && scoped.watchlist[0]?.symbol === SYM);
  check("database context never leaks another user’s watched symbol", !scoped.watchlist.some((row) => row.symbol === otherSymbol) && !scoped.theses.some((thesis) => thesis.symbol === otherSymbol));
  const [ownItem] = await db.select().from(watchlistItems).where(eq(watchlistItems.userId, firstUser.id));
  await db.insert(theses).values({ watchlistItemId: ownItem.id, type: "price_range", paramsJson: { low: 90, high: 110 }, note: "Display only, unchanged" });
  const presentation = await getPresentationData(firstUser.id);
  check("dashboard reads only the current user's stored thesis and original note", presentation.theses.length === 1 && presentation.theses[0].symbol === SYM && presentation.theses[0].note === "Display only, unchanged");
  const [presentationBatch] = await db.insert(ingestionBatches).values({ status: "COMPLETED", completedAt: new Date() }).returning();
  await db.insert(changeEvents).values({ symbol: SYM, signalType: "large_move", window: "1d", magnitude: "1", score: "1", occurredAt: new Date(), detectedAt: new Date(), ingestionBatchId: presentationBatch.id, explainJson: { price: 100 } });
  check("featured evidence remains available outside the unread digest window", (await getStoredEvidence(firstUser.id, SYM)).entries.length > 0);
  check("featured evidence denies symbols outside watchlist membership", (await getStoredEvidence(secondUser.id, SYM)).entries.length === 0);
  await db.delete(changeEvents).where(eq(changeEvents.symbol, SYM));
  await db.delete(ingestionBatches).where(eq(ingestionBatches.id, presentationBatch.id));
  await db.delete(users).where(inArray(users.id, [firstUser.id, secondUser.id]));
  await db.delete(symbols).where(eq(symbols.symbol, otherSymbol));
}

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

/* ------------------------------------------------------------------------- */
section("thesis engine — creation floor, observation window, 2-of-3");
{
  const day = (n: number) => `2026-07-${String(n).padStart(2, "0")}`;
  const inst = (n: number) => new Date(`${day(n)}T10:00:00.000Z`);
  // A steadily falling series, so contradiction conditions are unambiguous.
  const falling = Array.from({ length: 40 }, (_, i) =>
    bar(`2026-0${i < 26 ? "7" : "8"}-${String((i % 26) + 1).padStart(2, "0")}`, 100 - i * 1.5, 5000));
  const flatBench = falling.map((b) => ({ ...b, close: 1000, adjClose: 1000 }));

  const base = {
    dailyBars: falling, benchmarkBars: flatBench, observations: [],
    anomalies: [], beta: 1, lastAcknowledgedAt: null, priorEvents: [],
  };

  // --- (e) creation floor ---------------------------------------------------
  const rangeParams = { low: 94, high: 96, context: { realizedVolAtCreation: 0.01, gapAtCreation: 2 } };
  const obsBefore = [{ at: new Date("2026-07-02T05:00:00Z"), price: 95 }];
  const obsAfter = [{ at: new Date("2026-07-20T05:00:00Z"), price: 95 }];

  const firedOnHistory = evaluateThesis({
    ...base, type: "price_range", params: rangeParams,
    createdAt: new Date("2026-07-10T00:00:00Z"), observations: obsBefore,
  }).filter((v) => v.kind === "triggered");
  check("creation floor: a range hit BEFORE the thesis existed does not fire",
    firedOnHistory.length === 0, `${firedOnHistory.length} triggers`);

  const firedAfter = evaluateThesis({
    ...base, type: "price_range", params: rangeParams,
    createdAt: new Date("2026-07-10T00:00:00Z"), observations: obsAfter,
  }).filter((v) => v.kind === "triggered");
  check("creation floor: the same hit AFTER creation does fire", firedAfter.length === 1);

  // --- (f) minimum observation window --------------------------------------
  const justCreated = evaluateThesis({
    ...base, type: "momentum_up", params: {},
    createdAt: inst(38),   // hours before the series ends
  }).filter((v) => v.kind === "contradicted");
  check("observation window: a thesis minutes old cannot be contradicted",
    justCreated.length === 0, `${justCreated.length}`);

  const matured = evaluateThesis({
    ...base, type: "momentum_up", params: {}, createdAt: new Date("2026-07-01T00:00:00Z"),
  }).filter((v) => v.kind === "contradicted");
  check("observation window: a matured thesis can be contradicted", matured.length >= 1);

  const acknowledgedJustNow = evaluateThesis({
    ...base, type: "momentum_up", params: {},
    createdAt: new Date("2026-07-01T00:00:00Z"),
    lastAcknowledgedAt: falling.length ? inst(38) : null,
  }).filter((v) => v.kind === "contradicted");
  check("acknowledgement restarts the observation window",
    acknowledgedJustNow.length === 0, `${acknowledgedJustNow.length}`);

  // --- (c) two of three, and latching --------------------------------------
  check("contradiction fires at most once until acknowledged", matured.length === 1, `${matured.length}`);
  check("the verdict records which conditions fired",
    matured[0].conditionsMet.length >= 2, matured[0].conditionsMet.join(", "));
  check("evidence records how many were required",
    (matured[0].evidence as Record<string, unknown>).conditions_required === 2);
  check("evidence records the persistence that confirmed it",
    typeof (matured[0].evidence as Record<string, unknown>).sustained_for_sessions === "number");

  // A rising series must not contradict an up-momentum thesis at all.
  const rising = Array.from({ length: 40 }, (_, i) =>
    bar(`2026-0${i < 26 ? "7" : "8"}-${String((i % 26) + 1).padStart(2, "0")}`, 100 + i * 1.5, 5000));
  const noFalseFire = evaluateThesis({
    ...base, dailyBars: rising, benchmarkBars: flatBench,
    type: "momentum_up", params: {}, createdAt: new Date("2026-07-01T00:00:00Z"),
  }).filter((v) => v.kind === "contradicted");
  check("a thesis that is still holding is never contradicted", noFalseFire.length === 0, `${noFalseFire.length}`);

  // --- lifecycle ------------------------------------------------------------
  check("a contradicted momentum thesis resolves to CONTRADICTED",
    resolveState("momentum_up", matured, null) === "CONTRADICTED");
  check("acknowledgement after the fact clears it back to STILL_VALID",
    resolveState("momentum_up", matured, new Date("2026-09-01T00:00:00Z")) === "STILL_VALID");
  check("a triggered price_range resolves to TRIGGERED",
    resolveState("price_range", firedAfter, null) === "TRIGGERED");
  check("a `none` thesis produces no verdicts at all",
    evaluateThesis({ ...base, type: "none", params: {}, createdAt: new Date("2026-07-01T00:00:00Z") }).length === 0);
}

/* ------------------------------------------------------------------------- */
section("corporate actions adjust what the USER typed");
{
  await reset();
  const [u] = await db.insert(users)
    .values({ email: `ca+${Date.now()}@example.com`, passwordHash: "x" }).returning();
  const [item] = await db.insert(watchlistItems)
    .values({ userId: u.id, symbol: SYM }).returning();
  const [batch] = await db.insert(ingestionBatches)
    .values({ status: "COMPLETED", requestedCount: 1 }).returning();

  // A user watching for "below ₹2,800", written before a 1:5 split.
  await db.insert(theses).values({
    watchlistItemId: item.id, type: "price_range",
    paramsJson: { low: 2700, high: 2800 }, note: "interested below 2800",
    createdAt: new Date("2026-07-01T00:00:00Z"), state: "WATCHING",
  });
  await db.insert(userSymbolReadState).values({
    userId: u.id, symbol: SYM, lastSeenAt: new Date("2026-07-01T00:00:00Z"),
    lastSeenPriceAdj: "2750.0000",
  });
  await db.insert(corporateActions).values({
    fingerprint: `test-split-${Date.now()}`, symbol: SYM, candidateType: "split",
    factor: "0.2", affectedFrom: "2026-07-10", affectedTo: "2026-08-01",
    supportingBars: 20, status: "VALIDATED", reason: "test", batchId: batch.id,
    detectedAt: new Date(),
  });

  const result = await applyCorporateActions();
  check("the pending action is applied", result.applied === 1 && result.thesesAdjusted === 1,
    JSON.stringify(result));

  const [t] = await db.select().from(theses).where(eq(theses.watchlistItemId, item.id));
  const params = t.paramsJson as Record<string, unknown>;
  check("thesis parameters are scaled by the split factor",
    params.low === 540 && params.high === 560, `low=${params.low} high=${params.high}`);
  check("paramsAdjustedAt is set, so the change is surfaced not silent", t.paramsAdjustedAt != null);

  // The whole point: the user's numbers are never silently rewritten.
  const adjustments = params.adjustments as { before: Record<string, number>; after: Record<string, number>; factor: number }[];
  check("the prior values are retained for display",
    adjustments?.length === 1 && adjustments[0].before.low === 2700 && adjustments[0].before.high === 2800,
    JSON.stringify(adjustments?.[0]?.before));
  check("the new values are recorded alongside them",
    adjustments[0].after.low === 540 && adjustments[0].after.high === 560);

  const [rs] = await db.select().from(userSymbolReadState).where(eq(userSymbolReadState.userId, u.id));
  check("the watermark price is adjusted by the same factor",
    Number(rs.lastSeenPriceAdj) === 550, String(rs.lastSeenPriceAdj));

  // Idempotent: a second run must not compound the adjustment.
  await applyCorporateActions();
  const [again] = await db.select().from(theses).where(eq(theses.watchlistItemId, item.id));
  const p2 = again.paramsJson as Record<string, unknown>;
  check("re-running does not compound the adjustment", p2.low === 540 && p2.high === 560,
    `low=${p2.low}`);

  await db.delete(users).where(eq(users.id, u.id));
}

/* ------------------------------------------------------------------------- */
section("digest read receipts are monotonic and scoped to the watchlist");
{
  await reset();
  const [u] = await db.insert(users)
    .values({ email: `digest+${Date.now()}@example.com`, passwordHash: "x" }).returning();
  await db.insert(watchlistItems).values({ userId: u.id, symbol: SYM });

  const newer = new Date("2026-09-04T06:00:00.000Z");
  const older = new Date("2026-09-04T05:00:00.000Z");
  await advanceDigestWatermark(u.id, newer);
  await advanceWatermark(u.id, [SYM], older);

  const [state] = await db.select().from(userSymbolReadState)
    .where(and(eq(userSymbolReadState.userId, u.id), eq(userSymbolReadState.symbol, SYM)));
  check("digest receipt creates a per-symbol watermark", state != null);
  check("an older tab cannot move the watermark backwards",
    state.lastSeenAt.getTime() === newer.getTime(), state.lastSeenAt.toISOString());

  await db.delete(users).where(eq(users.id, u.id));
}

await reset();
await db.delete(symbols).where(eq(symbols.symbol, SYM));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
