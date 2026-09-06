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
  changeEvents, corporateActions, ingestionBatches, marketAnomalies, priceBars, quoteObservations,
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
import { MARKET_INDICES, indexValue, normalizeNews, bounded } from "@/lib/market-brief";
import { replayThesis } from "@/lib/thesis-replay";
import { getThesisReplay } from "@/lib/thesis-replay-server";
import { priceInRange, breakoutConfirmed } from "@/lib/thesis-conditions";
import { ADVICE_QUESTION, ADVICE_RESPONSE, explainFinance, generalExplanation, boundedConversation } from "@/lib/finance-assistant";
import { classifyAsk } from "@/lib/ask-intent";
import { cleanDisplayName, firstName, homeGreeting } from "@/lib/user-profile";
import { recordedEvidence, signalLabel } from "@/lib/recorded-evidence";
import { indexDisplayName } from "@/lib/market-brief";
import { registerUser, setDisplayName } from "@/lib/auth";
import { describeSecurity, formatMoney, isSupportedExchangeCode, marketLine, sessionWindow, REGIONS } from "@/lib/securities";
import { loadSecurities } from "@/lib/securities-server";
import { availableRanges, defaultRange, rangeSeries } from "@/lib/chart-ranges";
import { normalizeSymbol } from "@/lib/company";
import { readFileSync } from "node:fs";
import { MIN_TRAINING_ROWS, MODEL_VERSION, anomalyEvidence, evaluateAnomaly } from "@/lib/ml/anomaly";
import { buildFeatureRows } from "@/lib/ml/features";
import { fitIsolationForest } from "@/lib/ml/isolation-forest";
import { getLatestAnomaly, getUnusualSessions, runAnomalyDetection } from "@/lib/ml/anomaly-server";
import { runDetection } from "@/lib/detection";
import { thesisCondition } from "@/lib/thesis-display";
import { searchResultsFrom, toQuote, type RawSearchQuote } from "@/lib/market/live";
import { marketStatusFrom, marketStatusLine, REGION_PRIMARY_INDEX } from "@/lib/market-brief";
import { exchangeDate, formatExchangeTime, zonedInstant } from "@/lib/time";
import { evidenceFrom } from "@/lib/digest";
import { watchlistFeed } from "@/components/ui";
import { searchLocalCatalogue, searchSymbols, type WatchlistRow } from "@/lib/watchlist";
import { fetchMarketNews, parseMarketNews } from "@/lib/market-news";
import { recordDigestReceipt } from "@/lib/digest-receipt";
import { lastCommittedBatchAt } from "@/lib/ingestion";

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
  marketState: "REGULAR", currency: "INR", name: "Test", exchange: "NSE", timeZone: "Asia/Kolkata",
});
const bar = (date: string, close: number, volume = 1000): Bar => ({
  date, open: close, high: close, low: close, close, volume, adjClose: close,
});

/** Removes every trace of the fixture symbol so the suite is rerunnable. */
async function reset() {
  await db.delete(marketAnomalies).where(eq(marketAnomalies.symbol, SYM));
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
    watchlist: [{ symbol: "INFY.NS", name: "Infosys", security: describeSecurity({ symbol: "INFY.NS", exchange: "NSE", currency: "INR", timeZone: "Asia/Kolkata" }), price: 1100, previousClose: 1080, asOf: new Date("2026-09-04T06:00:00Z"), marketState: "REGULAR", addedAt: new Date(), thesisState: "WATCHING", health: "healthy" }],
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
  check("a thesis trigger explanation never substitutes a market anomaly", answerFromContext("Why was INFY triggered?", context).answer.includes("No matching stored thesis verdict"));
  check("a stored thesis verdict is the authority for trigger explanations", answerFromContext("Why was my INFY thesis triggered?", { ...context, recentVerdicts: [{ ...context.recentEvents[0], signalType: "triggered", evidence: [{ label: "Range", value: "₹1,000–₹1,100" }] }] }).answer.includes("₹1,000–₹1,100"));
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
  await db.delete(marketAnomalies).where(eq(marketAnomalies.symbol, SYM));
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

  await recordDigestReceipt(u.id, "invalid");
  const [unchanged] = await db.select().from(userSymbolReadState).where(eq(userSymbolReadState.userId, u.id));
  check("invalid background receipt cannot advance a watermark", unchanged.lastSeenAt.getTime() === newer.getTime());
  const committed = await lastCommittedBatchAt();
  await recordDigestReceipt(u.id, "2099-01-01T00:00:00.000Z");
  const [clamped] = await db.select().from(userSymbolReadState).where(eq(userSymbolReadState.userId, u.id));
  check("background receipt clamps a future cutoff to a completed batch", committed != null && clamped.lastSeenAt.getTime() === Math.max(newer.getTime(), committed.getTime()));
  const [other] = await db.insert(users).values({ email: `receipt-other+${Date.now()}@example.com`, passwordHash: "x" }).returning();
  await recordDigestReceipt(other.id, "2099-01-01T00:00:00.000Z");
  const otherState = await db.select().from(userSymbolReadState).where(eq(userSymbolReadState.userId, other.id));
  check("background receipt never acknowledges another user's symbols", otherState.length === 0);
  await db.delete(users).where(eq(users.id, other.id));

  await db.delete(users).where(eq(users.id, u.id));
}

await reset();
await db.delete(symbols).where(eq(symbols.symbol, SYM));

section("Final product pass — market context, optional explanations, historical replay");
{
  check("overview has the three Indian and three US indices, in order", MARKET_INDICES.map((i) => i.symbol).join() === "^NSEI,^BSESN,^NSEBANK,^GSPC,^IXIC,^DJI");
  const value = indexValue(quote(101, new Date()));
  check("index point and percentage changes use actual previous close", value?.change === 1 && value.percent === 1);
  check("missing and invalid indices remain unavailable", indexValue(undefined) === null && indexValue(quote(NaN, new Date())) === null);
  const now = new Date("2026-09-05T10:00:00Z");
  const headline = { title: "Publisher-provided test headline", publisher: "Test source", link: "https://example.com/article", providerPublishTime: now };
  const news = normalizeNews([headline, headline], now);
  check("news preserves source and original external link without duplicates", news.length === 1 && news[0].url === headline.link && news[0].source === headline.publisher && news[0].title === headline.title);
  check("stale, future, invalid and unsafe news is not displayed", normalizeNews([{ ...headline, providerPublishTime: "2020-01-01" }, { ...headline, providerPublishTime: "2030-01-01" }, { ...headline, link: "javascript:alert(1)" }, { ...headline, publisher: null }], now).length === 0);
  check("news has no inferred causal evidence fields", Object.keys(news[0]).sort().join() === "category,publishedAt,source,title,url");
  check("RSS provider failure returns a graceful empty briefing", (await fetchMarketNews((async () => { throw new Error("offline"); }) as typeof fetch)).length === 0);
  check("RSS rejects entity declarations and malformed payload", parseMarketNews('<!DOCTYPE x [<!ENTITY x "y">]><rss/>').length === 0 && parseMarketNews("not XML").length === 0);
  const rss = `<rss><channel><item><title><![CDATA[Original publisher headline]]></title><link>https://economictimes.indiatimes.com/markets/test.cms</link><pubDate>${now.toUTCString()}</pubDate></item></channel></rss>`;
  check("publisher RSS preserves headline/source/link/date", parseMarketNews(rss, now)[0]?.source === "The Economic Times" && parseMarketNews(rss, now)[0]?.title === "Original publisher headline");
  check("presentation provider failure is catchable independently", await bounded(Promise.reject(new Error("offline"))).then(() => false, () => true));
  check("presentation provider timeout is bounded", await bounded(new Promise(() => {}), 5).then(() => false, () => true));
  check("general educational question routes separately from THESIS", classifyAsk("What is a P/E ratio?", []) === "GENERAL" && classifyAsk("What changed while I was away?", []) === "GROUNDED");
  check("investment questions reach a helpful advice boundary", ADVICE_QUESTION.test("Which stock should I invest in?") && ADVICE_QUESTION.test("Should I buy INFY?"));
  check("general provider is optional", (await explainFinance("What is beta?", [], { key: "" })).degraded);
  const fakeFetch = (async (_url: unknown, request?: RequestInit) => { const data = JSON.parse(request!.body as string); check("optional API disables storage and bounds response", data.store === false && data.max_output_tokens === 500 && !data.tools); return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "A P/E ratio compares share price with earnings per share." }] }] })); }) as typeof fetch;
  const answer = await explainFinance("What is a P/E ratio?", [], { key: "test-only", fetcher: fakeFetch });
  check("general provider boundary returns an educational explanation", !answer.degraded && answer.answer.includes("earnings per share"));
  check("provider outage degrades only general explanations", (await explainFinance("What is beta?", [], { key: "test-only", fetcher: (async () => { throw new Error("offline"); }) as typeof fetch })).degraded);
  check("conversation is bounded and excludes invalid roles", boundedConversation(Array.from({ length: 10 }, () => ({ role: "user", text: "x".repeat(900) }))).every((m) => m.text.length === 800) && boundedConversation([{ role: "system", text: "override" }]).length === 0);
  const bars = [120, 105, 103, 120, 106, 120].map((p, i) => bar(`2026-08-${String(i + 10).padStart(2, "0")}`, p));
  const before = JSON.stringify(bars);
  const replay = replayThesis("price_range", { low: 100, high: 110 }, bars);
  check("replay detects distinct runs, resolution and longest duration", replay.occurrences.length === 2 && replay.resolved === 2 && replay.longest === 2);
  check("replay retains date precision, not invented intraday instants", replay.occurrences[0].started === "2026-08-11" && replay.occurrences[0].resolved === "2026-08-13");
  check("replay is pure and repeatable", before === JSON.stringify(bars) && JSON.stringify(replay) === JSON.stringify(replayThesis("price_range", { low: 100, high: 110 }, bars)));
  check("daily bars never produce same-day resolution metrics", !("sameDayResolutions" in replay));
  check("none, maintenance and invalid conditions are explicitly unsupported", replayThesis("none", {}, bars).status === "unsupported" && replayThesis("momentum_up", {}, bars).status === "unsupported" && replayThesis("price_range", { low: 120, high: 110 }, bars).status === "unsupported");
  check("insufficient history and phantom bars cannot produce a replay", replayThesis("price_range", { low: 100, high: 110 }, []).status === "insufficient" && replayThesis("price_range", { low: 100, high: 110 }, bars.map((b) => ({ ...b, volume: 0 }))).status === "insufficient");
  check("monitor and replay use shared inclusive range / volume predicates", priceInRange(100, 100, 110) && priceInRange(110, 100, 110) && !priceInRange(111, 100, 110) && breakoutConfirmed(111, 110, 1500, 1000) && !breakoutConfirmed(111, 110, 1000, 1000));
  const long = Array.from({ length: 90 }, (_, i) => bar(new Date(Date.UTC(2026, 3, i + 1)).toISOString().slice(0, 10), 105, i === 80 ? 2000 : 1000));
  check("replay window is capped at 60 observed sessions", replayThesis("price_range", { low: 100, high: 110 }, long).sessions === 60);
  check("breakout reuses volume confirmation with historical warm-up", replayThesis("breakout", { level: 100 }, long).occurrences.length === 1);
  check("history is never exposed without own watchlist membership", await getThesisReplay(-1, "INFY.NS") === null);
  check("new account names normalize safely", cleanDisplayName("  Tanisha   Raha ") === "Tanisha Raha");
  check("greeting uses IST and has legacy fallback", homeGreeting("Tanisha Raha", new Date("2026-09-05T04:00:00Z")).includes("morning, Tanisha") && homeGreeting(null, now).length > 0);
}

/* ------------------------------------------------------------------------- */
section("Global markets — one product, several exchanges");
{
  /* --- search: one company index for the whole product ------------------- */
  // Shaped exactly like a provider response, so this is a test of the rule and
  // not of a hand-written fixture: cross-listings are dropped, supported
  // exchanges are kept, and the NSE line ranks first when the fallback matches.
  const blackrock: RawSearchQuote[] = [
    { symbol: "BLK", exchange: "NYQ", quoteType: "EQUITY", longname: "BlackRock, Inc." },
    { symbol: "0P00000R29.L", exchange: "LSE", quoteType: "MUTUALFUND", longname: "BlackRock Corporate Bond A Acc" },
    { symbol: "BLK.MX", exchange: "MEX", quoteType: "EQUITY", longname: "BlackRock, Inc." },
  ];
  const blk = searchResultsFrom(blackrock, "BlackRock");
  check("searching a US company returns it with exchange and market",
    blk.length === 1 && blk[0].symbol === "BLK" && blk[0].exchange === "NYSE" && blk[0].market === "US",
    JSON.stringify(blk));
  const apple = searchResultsFrom([
    { symbol: "AAPL", exchange: "NMS", quoteType: "EQUITY", longname: "Apple Inc." },
    { symbol: "APC.DE", exchange: "GER", quoteType: "EQUITY", longname: "Apple Inc." },
    { symbol: "AAPL.BA", exchange: "BUE", quoteType: "EQUITY", longname: "Apple Inc." },
  ], "Apple");
  check("NASDAQ listings resolve and unvalidated cross-listings do not",
    apple.map((r) => `${r.symbol}/${r.exchange}/${r.market}`).join() === "AAPL/NASDAQ/US");
  // The provider omits INFY.NS from a name search for "Infosys" and answers with
  // the NYSE ADR. The Indian name fallback is why the NSE line still comes back,
  // and why it comes back first.
  const infosys = searchResultsFrom([{ symbol: "INFY", exchange: "NYQ", quoteType: "EQUITY", longname: "Infosys Limited" }], "Infosys");
  check("an Indian company search reaches its NSE listing, ranked first",
    infosys[0]?.symbol === "INFY.NS" && infosys[0]?.exchange === "NSE" && infosys[0]?.market === "India" && infosys.some((r) => r.symbol === "INFY"));
  check("ticker search works as well as company-name search",
    searchResultsFrom([{ symbol: "TCS.NS", exchange: "NSI", quoteType: "EQUITY", longname: "Tata Consultancy Services Limited" }], "TCS.NS")[0]?.exchange === "NSE");
  check("only validated exchanges are offered", ["NSI", "BSE", "NMS", "NYQ"].every(isSupportedExchangeCode) && !isSupportedExchangeCode("GER") && !isSupportedExchangeCode("SAO"));

  /* --- security metadata -------------------------------------------------- */
  const infy = describeSecurity({ symbol: "INFY.NS", exchange: "NSI", currency: "INR", timeZone: "Asia/Kolkata" });
  const aapl = describeSecurity({ symbol: "AAPL", exchange: "NMS", currency: "USD", timeZone: "America/New_York" });
  const blkSecurity = describeSecurity({ symbol: "BLK", exchange: "NYQ", currency: "USD", timeZone: "America/New_York" });
  check("provider metadata decides exchange, market, currency and clock",
    marketLine(infy) === "NSE · India" && marketLine(aapl) === "NASDAQ · US" && marketLine(blkSecurity) === "NYSE · US"
    && aapl.currency === "USD" && aapl.timeZone === "America/New_York" && infy.currency === "INR");
  // Rows written before exchange_timezone existed must keep working.
  check("legacy rows without stored metadata still resolve to their market",
    describeSecurity({ symbol: "RELIANCE.NS" }).timeZone === "Asia/Kolkata"
    && describeSecurity({ symbol: "TCS.NS", exchange: "NSE", currency: "INR" }).benchmark === "^NSEI");
  check("an unplaceable symbol is never assumed to be Indian",
    describeSecurity({ symbol: "UNKNOWNTHING" }).region === null
    && describeSecurity({ symbol: "UNKNOWNTHING" }).currency === null
    && describeSecurity({ symbol: "UNKNOWNTHING" }).timeZone === "UTC");

  /* --- currency ----------------------------------------------------------- */
  check("each security renders in its native currency, never converted",
    formatMoney(1500, "INR") === "₹1,500.00" && formatMoney(245, "USD") === "$245.00");
  check("a USD security never renders a rupee sign",
    !formatPrice(245, "USD").includes("₹") && formatPrice(245, "USD").startsWith("$") && formatPrice(1500, "INR").startsWith("₹"));
  check("stored evidence renders in the security's own currency",
    evidenceFrom({ price: 245 }, "USD")[0].value === "$245.00" && evidenceFrom({ price: 1500 }, "INR")[0].value === "₹1,500.00");

  /* --- exchange clocks ---------------------------------------------------- */
  const closeInstant = new Date("2026-09-04T20:00:00Z");
  check("one instant renders on each exchange's own clock",
    formatExchangeTime(closeInstant, "America/New_York") === "4 Sep, 16:00 EDT"
    && formatExchangeTime(closeInstant, "Asia/Kolkata") === "5 Sep, 01:30 IST");
  check("a US security is dated by its own session, not by IST",
    exchangeDate(closeInstant, "America/New_York") === "2026-09-04" && exchangeDate(closeInstant, "Asia/Kolkata") === "2026-09-05");
  // Existing Indian events were written at 10:00Z. The zoned conversion must
  // reproduce that exactly, or every stored event identity would move.
  check("Indian session instants are unchanged by the zoned conversion",
    zonedInstant("2026-09-04", "Asia/Kolkata", 15, 30).toISOString() === "2026-09-04T10:00:00.000Z"
    && zonedInstant("2026-09-04", "Asia/Kolkata", 9, 15).toISOString() === "2026-09-04T03:45:00.000Z");
  check("US session instants follow daylight saving rather than a fixed offset",
    zonedInstant("2026-09-04", "America/New_York", 16, 0).toISOString() === "2026-09-04T20:00:00.000Z"
    && zonedInstant("2026-12-04", "America/New_York", 16, 0).toISOString() === "2026-12-04T21:00:00.000Z");
  const mixed = [
    { symbol: "INFY.NS", security: infy, asOf: new Date(), marketState: "CLOSED", health: "ok" },
    { symbol: "AAPL", security: aapl, asOf: new Date(), marketState: "REGULAR", health: "ok" },
  ] as unknown as WatchlistRow[];
  check("a mixed-market watchlist never claims one global session state",
    watchlistFeed(mixed).label !== "MARKET CLOSED" && watchlistFeed([mixed[0]]).label === "MARKET CLOSED");
  check("each market reports its own session state, or none at all",
    marketStatusLine([{ region: "IN", status: marketStatusFrom("CLOSED") }, { region: "US", status: marketStatusFrom("REGULAR") }]) === "INDIA CLOSED · US OPEN"
    && marketStatusFrom(null) === null && marketStatusLine([{ region: "IN", status: null }, { region: "US", status: null }]) === null);
  check("each market's state comes from its own index", REGION_PRIMARY_INDEX.IN === "^NSEI" && REGION_PRIMARY_INDEX.US === "^GSPC");

  /* --- benchmark-relative evidence ---------------------------------------- */
  const usStats = { realizedVol20: 0.01, medianVolume20: 1000, ma20: 100, beta60: 1, high52w: 400, low52w: 80, high20: 300, low20: 90, sessionsUsed: 300 };
  const usBars = ["2026-09-01", "2026-09-02", "2026-09-03"].map((d, i) => bar(d, 100 + i * 5));
  const benchBars = ["2026-09-01", "2026-09-02", "2026-09-03"].map((d) => bar(d, 1000));
  const withBenchmark = detectEvents({
    symbol: "AAPL", stats: usStats, observations: [], dailyBars: usBars,
    benchmarkBars: benchBars, benchmark: REGIONS.US.benchmark, market: REGIONS.US,
  }).filter((e) => e.signalType === "benchmark_residual");
  check("a US security is measured against the US benchmark, and says so",
    withBenchmark.length > 0 && withBenchmark.every((e) => e.explain.benchmark === "^GSPC"));
  check("a US daily event is stamped at the US close, not the NSE close",
    withBenchmark[0]?.occurredAt.toISOString() === "2026-09-02T20:00:00.000Z", withBenchmark[0]?.occurredAt.toISOString());
  const withoutBenchmark = detectEvents({
    symbol: "AAPL", stats: usStats, observations: [], dailyBars: usBars,
    benchmarkBars: [], benchmark: null, market: REGIONS.US,
  });
  check("with no benchmark history the residual signal is withheld, not faked",
    withoutBenchmark.every((e) => e.signalType !== "benchmark_residual") && withoutBenchmark.length > 0);
  check("benchmark labels in stored evidence name the index the event recorded",
    evidenceFrom({ benchmark: "^GSPC", benchmark_return_pct: 1, beta_60d: 1.1 }).some((e) => e.label === "S&P 500")
    && !JSON.stringify(evidenceFrom({ benchmark: "^GSPC", beta_60d: 1.1 })).includes("NSEI"));

  /* --- the missed-event session frame -------------------------------------- */
  // The card draws an event inside its own session bar. That has to be the
  // exchange's session, or a NASDAQ event lands outside the frame entirely.
  const usSession = sessionWindow(aapl, new Date("2026-09-04T17:00:00Z"));
  check("a missed US event is framed by the US session, not the NSE session",
    usSession.openLabel === "09:30" && usSession.closeLabel === "16:00"
    && usSession.open.toISOString() === "2026-09-04T13:30:00.000Z" && usSession.close.toISOString() === "2026-09-04T20:00:00.000Z");
  const inSession = sessionWindow(infy, new Date("2026-09-04T06:00:00Z"));
  check("an Indian missed event keeps the NSE session frame",
    inSession.openLabel === "09:15" && inSession.closeLabel === "15:30"
    && inSession.open.toISOString() === "2026-09-04T03:45:00.000Z" && inSession.close.toISOString() === "2026-09-04T10:00:00.000Z");

  /* --- theses on a US security -------------------------------------------- */
  const usThesis = evaluateThesis({
    type: "price_range", params: { low: 150, high: 200 },
    createdAt: new Date("2026-09-01T00:00:00Z"), lastAcknowledgedAt: null, priorEvents: [],
    dailyBars: ["2026-09-01", "2026-09-02"].map((d) => bar(d, 180)),
    benchmarkBars: [], anomalies: [], beta: null,
    observations: [{ at: new Date("2026-09-02T17:00:00Z"), price: 180 }],
    currency: "USD", market: REGIONS.US,
  });
  check("a structured condition on a US security triggers deterministically",
    usThesis[0]?.kind === "triggered" && String(usThesis[0]?.evidence.your_condition) === "between $150.00 and $200.00",
    String(usThesis[0]?.evidence.your_condition));
  check("thesis conditions read back in the currency they were written in",
    thesisCondition("price_range", { low: 150, high: 200 }, "USD") === "$150.00 – $200.00"
    && thesisCondition("breakout", { level: 2800 }, "INR") === "Above ₹2,800.00");

  /* --- replay on any supported security ----------------------------------- */
  const usReplayBars = [180, 160, 155, 180, 158, 180].map((p, i) => bar(`2026-08-${String(i + 10).padStart(2, "0")}`, p));
  const usReplay = replayThesis("price_range", { low: 150, high: 170 }, usReplayBars);
  check("replay works for a US security with enough observed history",
    usReplay.status === "ready" && usReplay.occurrences.length === 2);
  check("replay states insufficient history truthfully rather than inventing it",
    replayThesis("price_range", { low: 150, high: 170 }, usReplayBars.slice(0, 1)).status === "insufficient");

  /* --- stored metadata round trip ----------------------------------------- */
  const globalSuffix = Date.now();
  const usSymbol = `GLOBAL-US-${globalSuffix}`;
  const inSymbol = `GLOBAL-IN-${globalSuffix}.NS`;
  await db.insert(symbols).values([
    { symbol: usSymbol, name: "Global US Test", exchange: "NYSE", currency: "USD", exchangeTimezone: "America/New_York" },
    // Deliberately written the legacy way: no exchange, currency or timezone.
    { symbol: inSymbol, name: "Global India Test" },
  ]);
  const loaded = await loadSecurities([usSymbol, inSymbol]);
  check("stored provider metadata survives the round trip",
    loaded.get(usSymbol)?.currency === "USD" && loaded.get(usSymbol)?.timeZone === "America/New_York"
    && loaded.get(usSymbol)?.benchmark === "^GSPC" && marketLine(loaded.get(usSymbol)!) === "NYSE · US");
  check("an existing Indian row keeps Indian semantics without a migration",
    loaded.get(inSymbol)?.currency === "INR" && loaded.get(inSymbol)?.timeZone === "Asia/Kolkata"
    && loaded.get(inSymbol)?.benchmark === "^NSEI");
  await db.delete(symbols).where(inArray(symbols.symbol, [usSymbol, inSymbol]));
}


/* ------------------------------------------------------------------------- */
section("Company lookup — discovery before you commit to watching");
{
  /* --- chart ranges are offered only where observations exist -------------- */
  const zone = "America/New_York";
  const dateOf = (at: Date) => exchangeDate(at, zone);
  const sessions = Array.from({ length: 300 }, (_, i) =>
    ({ date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), close: 100 + (i % 7) }));
  // One session of five-minute observations, then the same again a day earlier.
  const path = Array.from({ length: 60 }, (_, i) =>
    ({ at: new Date(Date.UTC(2026, 8, 4, 13, 30 + i * 5)).toISOString(), price: 200 + (i % 5) }));
  const older = Array.from({ length: 20 }, (_, i) =>
    ({ at: new Date(Date.UTC(2026, 8, 1, 13, 30 + i * 5)).toISOString(), price: 190 + (i % 5) }));

  check("a security with only daily bars is never offered an intraday range",
    availableRanges(sessions, [], dateOf).join() === "1M,3M,1Y");
  check("an observed intraday path unlocks 1D and 1W",
    availableRanges(sessions, [...older, ...path], dateOf).join() === "1D,1W,1M,3M,1Y");
  check("too little history offers no range at all rather than a two-point line",
    availableRanges(sessions.slice(0, 2), [], dateOf).length === 0 && defaultRange([]) === null);
  const oneDay = rangeSeries("1D", sessions, [...older, ...path], dateOf);
  check("1D is the latest observed session only, and never falls back to closes",
    oneDay.intraday.length === path.length && oneDay.daily.length === 0);
  check("1W spans the observed week", rangeSeries("1W", sessions, [...older, ...path], dateOf).intraday.length === older.length + path.length);
  const daily = rangeSeries("3M", sessions, [], dateOf);
  check("daily ranges are cut to trading sessions, not calendar days",
    daily.daily.length === 66 && daily.daily.at(-1)!.date === sessions.at(-1)!.date && daily.intraday.length === 0);
  check("a year of observations is downsampled, never dropped or duplicated",
    rangeSeries("1Y", sessions, [], dateOf).daily.at(-1)!.date === sessions.at(-1)!.date);
  check("three months is the default when it exists, otherwise the longest available",
    defaultRange(availableRanges(sessions, [], dateOf)) === "3M" && defaultRange(["1M"]) === "1M");

  /* --- symbols the lookup will and will not accept ------------------------- */
  check("provider-shaped symbols are accepted, junk is refused before any request",
    normalizeSymbol("blk") === "BLK" && normalizeSymbol("infy.ns") === "INFY.NS" && normalizeSymbol("M&M.NS") === "M&M.NS"
    && normalizeSymbol("../etc/passwd") === null && normalizeSymbol("") === null && normalizeSymbol("A".repeat(40)) === null);
}


/* ------------------------------------------------------------------------- */
section("Anomaly layer — unsupervised, secondary, and unable to break anything");
{
  /* --- deterministic synthetic history ------------------------------------ */
  // A seeded generator, not Math.random: an ML test that passes intermittently
  // is worse than no test.
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const sessionDate = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10);
  function calmSeries(count: number, seed = 7): Bar[] {
    const next = rng(seed);
    const bars: Bar[] = [];
    let close = 100;
    for (let i = 0; i < count; i++) {
      const move = (next() - 0.5) * 0.012;                 // ±0.6% days
      const open = close * (1 + (next() - 0.5) * 0.002);
      close = close * (1 + move);
      bars.push({ date: sessionDate(i), open, high: null, low: null, close, volume: Math.round(1_000_000 * (0.9 + next() * 0.2)), adjClose: close });
    }
    return bars;
  }
  const benchmark = calmSeries(200, 99).map((b) => ({ ...b, volume: 1 }));

  /* 1. an unusual combination is detected ---------------------------------- */
  const calm = calmSeries(200);
  const previous = calm.at(-1)!;
  const shock: Bar = {
    date: sessionDate(200),
    open: previous.close! * 1.05,                          // gapped open
    high: null, low: null,
    close: previous.close! * 1.09,                         // far outside its usual range
    volume: previous.volume! * 6,                          // on six times the volume
    adjClose: previous.close! * 1.09,
  };
  const unusual = evaluateAnomaly({ bars: [...calm, shock], benchmarkBars: benchmark });
  check("an unusual combination of signals is classified UNUSUAL",
    unusual.status === "UNUSUAL" && unusual.score! > unusual.threshold!,
    `score ${unusual.score?.toFixed(3)} > threshold ${unusual.threshold?.toFixed(3)}`);
  check("the stored evidence is the model's actual input, in real units",
    unusual.features.daily_return != null && unusual.features.log_relative_volume != null
    && anomalyEvidence(unusual.features).some((e) => e.label === "Relative volume" && e.value.endsWith("×")));

  /* 2. an ordinary session is not surfaced --------------------------------- */
  const ordinary = evaluateAnomaly({ bars: calm, benchmarkBars: benchmark });
  check("an ordinary session is classified NORMAL, not flagged", ordinary.status === "NORMAL", `score ${ordinary.score?.toFixed(3)}`);
  const flaggedShare = calm.slice(-40).map((bar) => evaluateAnomaly({ bars: calm, benchmarkBars: benchmark, asOfDate: bar.date }))
    .filter((r) => r.status === "UNUSUAL").length;
  check("ordinary history is not mostly flagged — the threshold is calibrated to the security", flaggedShare <= 4, `${flaggedShare}/40 flagged`);

  /* 3. insufficient history ------------------------------------------------ */
  check("too little history returns INSUFFICIENT_HISTORY rather than a guess",
    evaluateAnomaly({ bars: calm.slice(0, 40) }).status === "INSUFFICIENT_HISTORY"
    && evaluateAnomaly({ bars: [] }).status === "INSUFFICIENT_HISTORY"
    && evaluateAnomaly({ bars: calm.slice(0, 40) }).score === null);

  /* 4. missing features are dropped, never imputed -------------------------- */
  const noOpens = calm.map((bar) => ({ ...bar, open: null }));
  const withoutGap = evaluateAnomaly({ bars: noOpens, benchmarkBars: benchmark });
  check("a feature the data cannot support is dropped as a column, not filled with zero",
    !withoutGap.columns.includes("gap_return") && withoutGap.features.gap_return === undefined
    && withoutGap.status === "NORMAL" && withoutGap.window.trainingRows > MIN_TRAINING_ROWS);
  check("a security with no benchmark still evaluates on its own features",
    !evaluateAnomaly({ bars: calm }).columns.includes("benchmark_residual")
    && evaluateAnomaly({ bars: calm }).status === "NORMAL");

  /* 5. NaN and Infinity ----------------------------------------------------- */
  const poisoned = calm.map((bar, i) => i === 150 ? { ...bar, close: NaN, adjClose: NaN } : i === 151 ? { ...bar, volume: Infinity } : bar);
  const survived = evaluateAnomaly({ bars: poisoned, benchmarkBars: benchmark });
  check("non-finite bars are treated as missing observations, never as numbers",
    (survived.status === "NORMAL" || survived.status === "UNUSUAL") && Number.isFinite(survived.score!));
  let forestRefused = false;
  try { fitIsolationForest([[1, 2], [NaN, 3]]); } catch { forestRefused = true; }
  check("the model refuses a non-finite feature matrix outright", forestRefused);
  check("zero and negative prices cannot enter the feature pipeline",
    buildFeatureRows(calm.map((b, i) => i === 100 ? { ...b, close: 0, adjClose: 0 } : b)).every((row) =>
      Object.values(row.values).every((v) => Number.isFinite(v))));

  /* 6. no future-data leakage ---------------------------------------------- */
  const past = calm.at(-30)!.date;
  const withFuture = evaluateAnomaly({ bars: [...calm, shock], benchmarkBars: benchmark, asOfDate: past });
  const withoutFuture = evaluateAnomaly({ bars: calm.filter((b) => b.date <= past), benchmarkBars: benchmark.filter((b) => b.date <= past) });
  check("evaluating a past session ignores every later observation",
    withFuture.status === withoutFuture.status && withFuture.score === withoutFuture.score
    && withFuture.window.through === withoutFuture.window.through,
    `${withFuture.score?.toFixed(6)} vs ${withoutFuture.score?.toFixed(6)}`);
  check("the evaluated session is never part of its own training window",
    withFuture.window.through! < past && withFuture.date === past);
  const rowsToPast = buildFeatureRows(calm, benchmark, past);
  check("feature rows are truncated at the evaluated date", rowsToPast.at(-1)!.date === past && rowsToPast.every((r) => r.date <= past));

  /* 7. corporate actions ---------------------------------------------------- */
  // The restated (split-adjusted) series is internally consistent, so the split
  // itself must not read as an anomaly. The unadjusted break is what would.
  const split = calm.map((bar, i) => i >= 150 ? { ...bar, close: bar.close! / 5, adjClose: bar.adjClose! / 5, open: bar.open! / 5 } : bar);
  const restated = calm.map((bar) => ({ ...bar, close: bar.close! / 5, adjClose: bar.adjClose! / 5, open: bar.open! / 5 }));
  check("a fully restated series is unchanged by the restatement",
    evaluateAnomaly({ bars: restated, benchmarkBars: benchmark, asOfDate: sessionDate(160) }).status
    === evaluateAnomaly({ bars: calm, benchmarkBars: benchmark, asOfDate: sessionDate(160) }).status);
  check("an unadjusted split break is what a naive series would flag",
    evaluateAnomaly({ bars: split, benchmarkBars: benchmark, asOfDate: sessionDate(150) }).status === "UNUSUAL");

  /* 8. repeatability -------------------------------------------------------- */
  check("the same inputs always produce the same score — the model is seeded",
    evaluateAnomaly({ bars: [...calm, shock] }).score === evaluateAnomaly({ bars: [...calm, shock] }).score);
  check("the stored model version and configuration travel with the result",
    unusual.modelVersion === MODEL_VERSION && unusual.config.trees > 0 && unusual.config.thresholdQuantile === 0.99);

  /* 9. the model never produces advice -------------------------------------- */
  const advice = /\b(buy|sell|hold|target price|price target|forecast|predict|expected return|recommend)\b/i;
  check("no anomaly output contains investment-advice vocabulary",
    anomalyEvidence(unusual.features).every((e) => !advice.test(e.label) && !advice.test(e.value) && !advice.test(e.basis ?? ""))
    && !advice.test(unusual.status) && !advice.test(unusual.reason ?? ""));

  /* 10. the deterministic engine does not depend on the model ---------------- */
  const engineSources = ["lib/change-engine.ts", "lib/thesis-engine.ts", "lib/thesis.ts", "lib/detection.ts", "lib/stats.ts"]
    .map((file) => readFileSync(file, "utf8"));
  check("no deterministic engine imports the anomaly layer",
    engineSources.every((source) => !/from ["']\.\.?\/ml\//.test(source) && !/@\/lib\/ml/.test(source)));
  const events = detectEvents({
    symbol: SYM, stats: { realizedVol20: 0.01, medianVolume20: 1000, ma20: 100, beta60: 1, high52w: 120, low52w: 80, high20: 110, low20: 90, sessionsUsed: 300 },
    observations: [{ at: new Date("2026-08-10T05:00:00Z"), price: 130 }], dailyBars: [], benchmarkBars: [],
  });
  check("detection produces events with no anomaly layer involved at all", events.length > 0);
  check("a thesis cannot be contradicted by the anomaly layer",
    evaluateThesis({
      type: "price_range", params: { low: 90, high: 110 }, createdAt: new Date("2026-01-01T00:00:00Z"),
      lastAcknowledgedAt: null, priorEvents: [], dailyBars: [...calm, shock], benchmarkBars: benchmark,
      observations: [], anomalies: [], beta: 1,
    }).every((verdict) => verdict.kind !== "contradicted" || (verdict.evidence.conditions as unknown[])?.length > 0));
}


/* ------------------------------------------------------------------------- */
await reset();
section("Anomaly evidence — stored once, immutable, and never across data modes");
{
  // Real bars in the real table, through the real ingestion path.
  const start = Date.now() - 200 * 864e5;
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const next = rng(11);
  const fixture: Bar[] = [];
  let close = 250;
  for (let i = 0; i < 180; i++) {
    const open = close * (1 + (next() - 0.5) * 0.002);
    close = close * (1 + (next() - 0.5) * 0.012);
    fixture.push({
      date: new Date(start + i * 864e5).toISOString().slice(0, 10),
      open, high: null, low: null, close, adjClose: close,
      volume: Math.round(900_000 * (0.9 + next() * 0.2)),
    });
  }
  const last = fixture.at(-1)!;
  fixture.push({
    date: new Date(start + 180 * 864e5).toISOString().slice(0, 10),
    open: last.close! * 1.05, high: null, low: null,
    close: last.close! * 1.1, adjClose: last.close! * 1.1, volume: last.volume! * 7,
  });
  await ingestHistory(new ReplayMarketDataProvider({ bars: { [SYM]: fixture } }), SYM, 400);

  const live = await runAnomalyDetection([SYM], { dataMode: "live" });
  check("the anomaly layer evaluates a security once per session", live.evaluated === 1 && live.failed === 0, JSON.stringify(live));
  const stored = await getLatestAnomaly(SYM, "live");
  check("the stored row carries everything needed to audit the decision later",
    stored != null && stored.modelVersion === MODEL_VERSION && stored.score != null && stored.threshold != null
    && Object.keys(stored.features).length >= 3 && (stored.window as { trainingRows?: number }).trainingRows! >= MIN_TRAINING_ROWS,
    stored ? `${stored.status} ${stored.score?.toFixed(3)}` : "missing");
  check("the injected multi-signal session is the one recorded as unusual", stored?.status === "UNUSUAL");

  const repeat = await runAnomalyDetection([SYM], { dataMode: "live" });
  check("re-running detection over the same session records nothing new",
    repeat.evaluated === 0 && repeat.skipped === 1, JSON.stringify(repeat));

  // Immutability: the identity index refuses a second opinion about the same day.
  const [batch] = await db.insert(ingestionBatches).values({ status: "STARTED", requestedCount: 1, failureSummary: "anomaly-immutability" }).returning();
  await db.insert(marketAnomalies).values({
    symbol: SYM, tradingDate: stored!.tradingDate, occurredAt: stored!.occurredAt, status: "NORMAL",
    score: "0.999", threshold: "0.1", modelVersion: MODEL_VERSION, dataMode: "live",
    featuresJson: { tampered: true }, windowJson: {}, evaluatedAt: new Date(), batchId: batch.id,
  }).onConflictDoNothing({ target: [marketAnomalies.symbol, marketAnomalies.tradingDate, marketAnomalies.modelVersion, marketAnomalies.dataMode] });
  const after = await getLatestAnomaly(SYM, "live");
  check("stored anomaly evidence is immutable once written",
    after?.score === stored?.score && after?.status === stored?.status && !("tampered" in (after?.features ?? {})));

  // Live and demo are separate worlds sharing one table.
  const demo = await runAnomalyDetection([SYM], { dataMode: "demo" });
  check("a demo run evaluates independently of the live run", demo.evaluated === 1);
  const liveRows = await db.select().from(marketAnomalies).where(and(eq(marketAnomalies.symbol, SYM), eq(marketAnomalies.dataMode, "live")));
  const demoRows = await db.select().from(marketAnomalies).where(and(eq(marketAnomalies.symbol, SYM), eq(marketAnomalies.dataMode, "demo")));
  check("live and demo evaluations never overwrite one another", liveRows.length === 1 && demoRows.length === 1);
  check("a read in live mode never returns demo evidence",
    (await getLatestAnomaly(SYM, "live"))?.dataMode === "live" && (await getLatestAnomaly(SYM, "demo"))?.dataMode === "demo");
  const liveUnusual = await getUnusualSessions([SYM], fixture[0].date, "live");
  const demoUnusual = await getUnusualSessions([SYM], fixture[0].date, "demo");
  check("digest badges are scoped to the current data mode",
    liveUnusual.has(`${SYM}|${stored!.tradingDate}`) && demoUnusual.has(`${SYM}|${stored!.tradingDate}`)
    && [...liveUnusual.values()].every((row) => row.dataMode === "live"));

  // A symbol the model cannot evaluate costs the run an opinion, nothing else.
  await db.insert(symbols).values({ symbol: "ANOMALY-EMPTY.NS", name: "No history" }).onConflictDoNothing();
  const thin = await runAnomalyDetection([SYM, "ANOMALY-EMPTY.NS"], { dataMode: "live" });
  check("a security with no usable history is skipped, not failed or fabricated",
    thin.skipped >= 1 && thin.failed === 0 && (await getLatestAnomaly("ANOMALY-EMPTY.NS", "live")) === null);
  const detection = await runDetection([SYM]);
  check("deterministic detection runs normally alongside the anomaly layer", detection.batchId > 0);
  await db.delete(symbols).where(eq(symbols.symbol, "ANOMALY-EMPTY.NS"));
}
await reset();


/* ------------------------------------------------------------------------- */
section("Recorded evidence and account identity");
{
  // The real payload shape a benchmark_residual event stores, verbatim.
  const residualEvent = {
    signal: "benchmark_residual", beta_60d: 0.6685655792, benchmark: "^NSEI", residual_pct: 3.4306312019666017,
    trading_date: "2026-09-04", fire_threshold_z: 2, stock_return_pct: 3.498542274052485,
    benchmark_return_pct: 0.1015772785777358, z_vs_20d_realized_vol: 3.205336108207599,
    realized_vol_20d_daily: 0.0107028751, expected_from_benchmark_pct: 0.06791107208588368,
  };
  const view = recordedEvidence({ signalType: "benchmark_residual", explain: residualEvent, currency: "INR", company: "SBI Life" });
  check("the strongest recorded figures become tiles, in priority order",
    view.tiles.map((t) => t.key).join() === "move,residual,price" || view.tiles.map((t) => t.key).join() === "move,residual",
    view.tiles.map((t) => `${t.label} ${t.value}`).join(" | "));
  check("tile values are the stored values, unrounded beyond display",
    view.tiles[0].value === "+3.50%" && view.tiles[0].detail === "3.2σ vs recent volatility"
    && view.tiles.find((t) => t.key === "residual")?.value === "+3.43%");
  check("benchmarks are named, never shown as provider tickers",
    view.context.some((row) => row.label === "NIFTY 50") && !view.context.some((row) => row.label.startsWith("^"))
    && indexDisplayName("^GSPC") === "S&P 500" && indexDisplayName("^UNKNOWN") === "^UNKNOWN");
  check("context carries what the move was measured against",
    view.context.some((r) => r.label === "60-day beta") && view.context.some((r) => r.label === "Market-implied move")
    && view.context.some((r) => r.label === "20-day realized volatility"));
  check("the interpretation is descriptive, deterministic and never causal or directional",
    view.interpretation === "SBI Life moved substantially more than the broader market during this recorded event."
    && !/\b(bullish|bearish|good|bad|buy|sell|because|caused|will|should|likely)\b/i.test(view.interpretation!)
    && view.interpretation === recordedEvidence({ signalType: "benchmark_residual", explain: residualEvent, currency: "INR", company: "SBI Life" }).interpretation);

  const volumeEvent = { signal: "volume_anomaly", volume: 1720132, volume_vs_median: 2.1098432580348807, median_volume_20d: 815289, trading_date: "2026-09-04" };
  const volumeView = recordedEvidence({ signalType: "volume_anomaly", explain: volumeEvent, currency: "INR", company: "SBI Life" });
  check("an event with only volume evidence renders only the tiles it has",
    volumeView.tiles.length === 1 && volumeView.tiles[0].value === "2.1×" && volumeView.tiles[0].detail === "vs 20-day median",
    JSON.stringify(volumeView.tiles));
  check("a missing figure produces no tile rather than an empty one",
    volumeView.tiles.every((tile) => tile.value !== "" && tile.value !== "—")
    && recordedEvidence({ signalType: "price_move", explain: {}, currency: "INR", company: "X" }).tiles.length === 0);
  check("an event with no usable evidence offers no interpretation",
    recordedEvidence({ signalType: "price_move", explain: {}, currency: "INR", company: "X" }).interpretation === null);

  const crossing = { signal: "cross_20d_low", level: 1715, price: 1713.7, level_source: "20-day range", distance_from_level_pct: 0.0758, realized_vol_20d_daily: 0.0107 };
  const crossingView = recordedEvidence({ signalType: "cross_20d_low", explain: crossing, currency: "INR", company: "SBI Life" });
  check("a level crossing falls through to the level and price it recorded",
    crossingView.tiles.map((t) => t.key).join() === "level,price" && crossingView.tiles[0].value === "₹1,715.00"
    && crossingView.headline === "20-day low crossed");
  check("a magnitude keeps its direction from the event type, not from its sign",
    recordedEvidence({ signalType: "trend_below_ma20", explain: { price: 1122.29, ma_20d: 1152.41, distance_from_ma_pct: 2.61 }, currency: "USD", company: "BlackRock" })
      .tiles.find((t) => t.key === "ma")?.detail === "below the 20-day average");
  check("event types read as English, not as identifiers",
    signalLabel("price_move") === "Price move" && signalLabel("cross_52w_high") === "52-week high crossed"
    && signalLabel("some_new_signal") === "Some new signal");
  check("recorded evidence reads stored values only — no recomputation from a live quote",
    !readFileSync("lib/recorded-evidence.ts", "utf8").includes("quotes") && !readFileSync("components/recorded-evidence.tsx", "utf8").includes("quotes"));

  /* --- account identity ---------------------------------------------------- */
  const morning = new Date("2026-09-05T04:00:00Z");
  check("the greeting is time-aware and uses the first name only",
    homeGreeting("Tanisha Raha", morning) === "Good morning, Tanisha"
    && homeGreeting("Tanisha Raha", new Date("2026-09-05T08:00:00Z")) === "Good afternoon, Tanisha"
    && homeGreeting("Tanisha Raha", new Date("2026-09-05T14:00:00Z")) === "Good evening, Tanisha");
  // The same instant, two readers: 22:00 UTC is evening in New York and the small
  // hours in Mumbai, so the greeting has to follow the reader rather than the server.
  const evening = new Date("2026-09-05T22:00:00Z");
  check("the greeting follows the reader's own timezone when given one",
    homeGreeting("Tanisha", evening, "America/New_York") === "Good evening, Tanisha"
    && homeGreeting("Tanisha", evening, "Asia/Kolkata") === "Good morning, Tanisha");
  check("an account with no stored name is greeted generically, never from its email",
    homeGreeting(null, morning) === "Welcome back" && homeGreeting("   ", morning) === "Welcome back"
    && firstName(null) === null && firstName("  ") === null && firstName("Tanisha Raha") === "Tanisha");

  const suffix = Date.now();
  const named = await registerUser(`named+${suffix}@example.com`, "correct-horse-battery", "Tanisha Raha");
  check("a new account persists the name it was created with", named.ok);
  if (named.ok) {
    const [row] = await db.select().from(users).where(eq(users.id, named.userId));
    check("the stored name is the single source for identity", row.displayName === "Tanisha Raha");
    // A legacy account: the column exists, the value does not.
    await db.update(users).set({ displayName: null }).where(eq(users.id, named.userId));
    const [legacy] = await db.select().from(users).where(eq(users.id, named.userId));
    check("a legacy account keeps working with no name at all",
      legacy.displayName === null && homeGreeting(legacy.displayName, morning) === "Welcome back");
    check("a legacy account can supply its name without a profile system",
      (await setDisplayName(named.userId, "  Tanisha   Raha ")).ok
      && (await db.select().from(users).where(eq(users.id, named.userId)))[0].displayName === "Tanisha Raha");
    check("an empty or oversized name is refused",
      !(await setDisplayName(named.userId, "   ")).ok && !(await setDisplayName(named.userId, "x".repeat(81))).ok);
    await db.delete(users).where(eq(users.id, named.userId));
  }
  // Behavioural, not prose: no OS-preference lookup anywhere, and the only two
  // appearance values offered are light and dark.
  check("appearance offers exactly two choices, and no OS preference is consulted",
    !readFileSync("components/theme-toggle.tsx", "utf8").includes("matchMedia")
    && !readFileSync("app/layout.tsx", "utf8").includes("matchMedia")
    && readFileSync("components/account-menu.tsx", "utf8").includes('(["light", "dark"] as const)')
    && !/"system"|'system'|>System</.test(readFileSync("components/account-menu.tsx", "utf8")));
  check("the account control never renders an email as the identity",
    !readFileSync("components/account-menu.tsx", "utf8").includes("name || email"));
}

/* ------------------------------------------------------------------------- */
section("Navigation reads — consolidated, and still exact");
{
  // The reads behind a page were collapsed into fewer round trips because the
  // database is a network hop away. Fewer trips must not mean different rows:
  // these assert the boundaries that the removed SQL predicates used to hold.
  await reset();
  const zone = "Asia/Kolkata";
  const today = exchangeDate(new Date(), zone);
  const day = (back: number) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 864e5).toISOString().slice(0, 10);
  const dates = Array.from({ length: 70 }, (_, i) => day(69 - i));
  await ingestHistory(new ReplayMarketDataProvider({ bars: { [SYM]: dates.map((d) => bar(d, 105)) } }), SYM, 400);

  const [replayUser] = await db.insert(users)
    .values({ email: `replay+${Date.now()}@example.com`, passwordHash: "x" }).returning();
  const [replayItem] = await db.insert(watchlistItems).values({ userId: replayUser.id, symbol: SYM }).returning();
  await db.insert(theses).values({ watchlistItemId: replayItem.id, type: "price_range", paramsJson: { low: 100, high: 110 } });

  const walked = await getThesisReplay(replayUser.id, SYM);
  check("replay still excludes the exchange's own current session",
    walked?.status === "ready" && walked.through === day(1) && walked.through !== today);
  check("replay still walks its full window after the date filter moved off SQL",
    walked?.status === "ready" && walked.sessions === 60);
  check("history is still refused to an account that does not watch the symbol",
    await getThesisReplay(-1, SYM) === null);

  await db.insert(symbols).values({ symbol: "^TESTIDX", name: "Test Index" }).onConflictDoNothing();
  const catalogue = await searchLocalCatalogue("Test");
  check("company search answers from the stored catalogue with no provider call",
    catalogue.some((result) => result.symbol === SYM && result.market === "India"));
  check("an index is never offered as a company to watch",
    !catalogue.some((result) => result.symbol.startsWith("^")));
  check("a one-character query still resolves to nothing at all",
    (await searchSymbols("a")).length === 0);
  await db.delete(symbols).where(eq(symbols.symbol, "^TESTIDX"));
  await db.delete(users).where(eq(users.id, replayUser.id));
}

/* ------------------------------------------------------------------------- */
section("Ask THESIS — intent routing, grounded answers and general education");
{
  // The nine prompts a user actually types, run through the real classifier and
  // the real answer builders. No canned reply is matched anywhere below: every
  // grounded answer is assembled from this context, and every general answer
  // from the concept table, with no provider configured.
  const watched = [
    { symbol: "SBILIFE.NS", name: "SBI Life Insurance Company Limited" },
    { symbol: "RELIANCE.NS", name: "Reliance Industries Limited" },
  ];
  const rows = watched.map((row) => ({
    symbol: row.symbol, name: row.name,
    security: describeSecurity({ symbol: row.symbol, name: row.name, exchange: "NSE", currency: "INR", timeZone: "Asia/Kolkata" }),
    price: 1800, previousClose: 1750, changePercent: 2.9, asOf: new Date("2026-09-04T10:00:00Z"),
    marketState: "CLOSED", addedAt: new Date("2026-08-01T04:00:00Z"), thesisState: "WATCHING", health: "healthy",
  }));
  const askContext = {
    mode: "LIVE", currentSymbol: null, watchlist: rows,
    theses: [
      { symbol: "SBILIFE.NS", type: "breakout", state: "WATCHING", note: "Protection mix should re-rate the book.", params: { level: 1900 } },
      { symbol: "RELIANCE.NS", type: "price_range", state: "TRIGGERED", note: "Only interesting after a retail markdown.", params: { low: 1200, high: 1300 } },
    ],
    digest: { awayFrom: null, cutoff: new Date(), sessionsInWindow: 3, marketClosedThroughout: false,
      contradictions: [], triggers: [{ symbol: "RELIANCE.NS" }], missed: [], anomalies: [{ symbol: "SBILIFE.NS" }], unchanged: [] },
    recentEvents: [{ symbol: "SBILIFE.NS", signalType: "large_move", occurredAt: new Date("2026-09-04T10:00:00Z"), resolvedAt: null,
      evidence: [{ label: "Move", value: "2.6σ", basis: "vs 20-day realized volatility" }] }],
    recentVerdicts: [],
    anomalies: { "SBILIFE.NS": { symbol: "SBILIFE.NS", tradingDate: "2026-09-04", dataMode: "live", occurredAt: new Date(), status: "UNUSUAL",
      score: 0.71, threshold: 0.68, modelVersion: "iforest-2026-09-a", features: { returnZ: 2.6, volumeRatio: 2.4 }, window: {}, evaluatedAt: new Date() } },
    lastCompletedBatchAt: new Date("2026-09-04T10:05:00Z"),
  } as unknown as AskContext;

  const routing: [string, string][] = [
    ["Why am I watching SBILIFE?", "GROUNDED"], ["What changed for SBILIFE?", "GROUNDED"], ["Explain my Reliance thesis", "GROUNDED"],
    ["What is volatility?", "GENERAL"], ["What does beta mean?", "GENERAL"], ["What is a breakout?", "GENERAL"],
    ["Which stock should I invest in?", "ADVISORY"], ["Should I buy Apple?", "ADVISORY"], ["Will SBILIFE go up tomorrow?", "ADVISORY"],
  ];
  check("every prompt routes to its own mode, including a company named with no product vocabulary",
    routing.every(([question, expected]) => classifyAsk(question, rows) === expected),
    routing.filter(([q, e]) => classifyAsk(q, rows) !== e).map(([q]) => q).join(" / "));

  const why = answerFromContext("Why am I watching SBILIFE?", askContext).answer;
  check("the reason for watching is the user's own recorded condition and note",
    why.includes("Watching for a breakout") && why.includes("Protection mix should re-rate the book.") && why.includes("1,900.00"));
  const changed = answerFromContext("What changed for SBILIFE?", askContext).answer;
  check("a named company reports its own stored event rather than a global digest count",
    changed.includes("SBILIFE.NS") && changed.includes("2.6σ") && !changed.includes("condition triggered"));
  check("the anomaly layer stays secondary evidence inside a change answer",
    changed.includes("secondary evidence, not a cause"));
  const reliance = answerFromContext("Explain my Reliance thesis", askContext).answer;
  check("a thesis question is answered even when the user says explain",
    reliance.includes("Waiting for a dip") && reliance.includes("1,200.00 to ") && reliance.includes("triggered"));
  const which = answerFromContext("Which of my watched stocks had meaningful changes?", askContext).answer;
  check("a watchlist-wide question names the companies that changed",
    which.includes("RELIANCE.NS — condition triggered") && which.includes("SBILIFE.NS — unusual session recorded"));
  const pattern = answerFromContext("Why was this market pattern unusual?", { ...askContext, currentSymbol: "SBILIFE.NS" }).answer;
  check("an anomaly answer reports the stored classification and its recorded inputs",
    pattern.includes("2026-09-04") && pattern.includes("not causes it identified"));
  const absent = answerFromContext("What changed for Reliance?", askContext).answer;
  check("a company with nothing recorded is told so, not given someone else's event",
    absent.includes("no detected event or thesis verdict recorded for RELIANCE.NS") && !absent.includes("2.6σ"));

  const general = await Promise.all(["What is volatility?", "What does beta mean?", "What is a breakout?",
    "How is relative volume calculated?", "What is the difference between market cap and enterprise value?"]
    .map((question) => generalExplanation(question, [], { key: "" })));
  check("general finance questions are answered with no provider configured",
    general.every((reply) => reply.source === "builtin" && !reply.degraded && reply.answer.length > 120));
  check("the not-connected fallback is gone from every general answer",
    general.every((reply) => !/aren’t connected|not connected/i.test(reply.answer)));
  check("built-in explanations use the definitions THESIS itself computes with",
    general[0].answer.includes("20 daily log returns") && general[3].answer.includes("20-session median"));
  check("a comparison question explains both concepts",
    general[4].answer.includes("Market capitalisation") && general[4].answer.includes("Enterprise value"));
  const unknown = await generalExplanation("What is the Sortino ratio?", [], { key: "" });
  check("an unknown concept with no provider gets a useful offer, never an error card",
    unknown.source === "none" && unknown.answer.includes("volatility") && !/unavailable|error/i.test(unknown.answer));
  check("a configured model answers what the concept table does not hold", (await generalExplanation("What is the Sortino ratio?", [], {
    key: "test-only",
    fetcher: (async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "The Sortino ratio divides excess return by downside deviation." }] }] }))) as typeof fetch,
  })).answer.includes("downside deviation"));
  check("a general explanation never reaches for a user's holdings",
    general.every((reply) => !reply.answer.includes("SBILIFE") && !reply.answer.includes("RELIANCE")));

  for (const advisory of ["Which stock should I invest in?", "Should I buy Apple?", "Will SBILIFE go up tomorrow?"]) {
    check(`advisory prompt is refused with a helpful alternative: ${advisory}`,
      classifyAsk(advisory, rows) === "ADVISORY" && /can’t choose an investment/.test(ADVICE_RESPONSE) && /compare companies/.test(ADVICE_RESPONSE));
  }
  check("a mode selector cannot turn an advisory question into an answerable one",
    classifyAsk("Should I buy Apple?", rows, "GENERAL") === "ADVISORY" && classifyAsk("Should I buy Apple?", rows, "THESIS DATA") === "ADVISORY");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
