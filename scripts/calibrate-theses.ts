/**
 * Calibration, not correctness.
 *
 * A contradiction rule can pass every unit test and still fire on every stock
 * every day, or never fire at all. Both Phase 3 bugs were found by looking at
 * output distributions rather than by tests, and the thesis engine is far more
 * exposed to that failure mode: a rule that contradicts 40 of 50 symbols is
 * wrong no matter how green the suite is.
 *
 * So: instantiate every thesis type on every symbol, backdated to the start of
 * our seeded history, evaluate over the whole window, and report how often each
 * rule actually fires.
 *
 * Run: npm run calibrate
 */
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, priceBars, quoteObservations, symbolStats } from "@/db/schema";
import { evaluateThesis, type ThesisType, type ThesisInput } from "@/lib/thesis-engine";
import { BENCHMARK, EQUITY_UNIVERSE } from "@/lib/universe";
import type { Bar } from "@/lib/market/types";

const WINDOW_DAYS = 60;
/** Noise floor under test. Unset uses the engine's own default; sweep with FLOOR=n. */
const FLOOR = process.env.FLOOR ? Number(process.env.FLOOR) : undefined;
const createdAt = new Date(Date.now() - WINDOW_DAYS * 864e5);

async function bars(symbol: string): Promise<Bar[]> {
  const rows = await db
    .select({
      date: priceBars.tradingDate,
      open: priceBars.currentProviderOpen,
      close: priceBars.currentProviderClose,
      adjClose: priceBars.currentProviderAdjClose,
      volume: priceBars.currentProviderVolume,
    })
    .from(priceBars).where(eq(priceBars.symbol, symbol)).orderBy(asc(priceBars.tradingDate));
  return rows.map((r) => ({
    date: r.date, high: null, low: null,
    open: r.open == null ? null : Number(r.open),
    close: r.close == null ? null : Number(r.close),
    adjClose: r.adjClose == null ? null : Number(r.adjClose),
    volume: r.volume == null ? null : Number(r.volume),
  }));
}

const TYPES: ThesisType[] = [
  "price_range", "breakout", "momentum_up", "momentum_down",
  "volatility_watch", "volume_expansion",
];

type Row = { type: ThesisType; symbols: number; triggered: number; contradicted: number; totalContradictions: number };

const benchmarkBars = await bars(BENCHMARK);
const results = new Map<ThesisType, Row>(
  TYPES.map((t) => [t, { type: t, symbols: 0, triggered: 0, contradicted: 0, totalContradictions: 0 }]),
);
const perSymbolDetail: { symbol: string; type: ThesisType; triggers: number; contradictions: number }[] = [];

for (const symbol of EQUITY_UNIVERSE) {
  const [stats] = await db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1);
  if (!stats) continue;
  const daily = await bars(symbol);
  const obs = (await db
    .select({ at: quoteObservations.asOf, price: quoteObservations.price })
    .from(quoteObservations).where(eq(quoteObservations.symbol, symbol)).orderBy(asc(quoteObservations.asOf)))
    .map((r) => ({ at: r.at, price: Number(r.price) }));
  const anomalies = (await db
    .select({ occurredAt: changeEvents.occurredAt, magnitude: changeEvents.magnitude, signalType: changeEvents.signalType })
    .from(changeEvents).where(eq(changeEvents.symbol, symbol)))
    .map((r) => ({ occurredAt: r.occurredAt, magnitude: Number(r.magnitude), signalType: r.signalType }));

  // Conditions as they stood when the hypothetical thesis was written.
  const atCreation = daily.filter((b) => b.date <= createdAt.toISOString().slice(0, 10));
  const priceAtCreation = atCreation.length ? (atCreation.at(-1)!.adjClose ?? atCreation.at(-1)!.close) : null;
  if (!priceAtCreation) continue;

  const volAtCreation = (() => {
    const closes = atCreation.map((b) => b.adjClose ?? b.close).filter((c): c is number => c != null && c > 0).slice(-21);
    if (closes.length < 3) return null;
    const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i])).filter(Number.isFinite);
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    return Math.sqrt(rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1));
  })();

  // Premise at creation: was the price above or below its 20-day average?
  // A user does not write "tracking momentum" on a stock that is already
  // falling, so instantiating momentum theses on every symbol regardless would
  // measure the rule against a prior no real user has. Calibrate against
  // realistic usage or the numbers mean nothing.
  const closesAtCreation = atCreation.map((b) => b.adjClose ?? b.close).filter((c): c is number => c != null && c > 0);
  const ma20AtCreation = closesAtCreation.length >= 20
    ? closesAtCreation.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;
  const hadUpMomentum = ma20AtCreation != null && priceAtCreation > ma20AtCreation;
  const hadDownMomentum = ma20AtCreation != null && priceAtCreation < ma20AtCreation;

  for (const type of TYPES) {
    if (type === "momentum_up" && !hadUpMomentum) continue;
    if (type === "momentum_down" && !hadDownMomentum) continue;
    // Plausible parameters a real user might write, anchored to the price at creation.
    const params =
      type === "price_range"
        ? { low: priceAtCreation * 0.95, high: priceAtCreation * 0.98,
            context: { priceAtCreation, realizedVolAtCreation: volAtCreation ?? undefined,
                       gapAtCreation: priceAtCreation * 0.03 } }
        : type === "breakout"
          ? { level: priceAtCreation * 1.03, context: { priceAtCreation, realizedVolAtCreation: volAtCreation ?? undefined } }
          : { context: { priceAtCreation, realizedVolAtCreation: volAtCreation ?? undefined } };

    const input: ThesisInput = {
      type, params, createdAt, lastAcknowledgedAt: null, priorEvents: [],
      dailyBars: daily, benchmarkBars, observations: obs, anomalies,
      beta: stats.beta60 == null ? null : Number(stats.beta60),
    };

    const verdicts = evaluateThesis(
      FLOOR == null ? input : { ...input, tuning: { noiseFloorSigmas: FLOOR } },
    );
    const triggers = verdicts.filter((v) => v.kind === "triggered").length;
    const contradictions = verdicts.filter((v) => v.kind === "contradicted").length;

    const row = results.get(type)!;
    row.symbols++;
    if (triggers > 0) row.triggered++;
    if (contradictions > 0) row.contradicted++;
    row.totalContradictions += contradictions;
    perSymbolDetail.push({ symbol, type, triggers, contradictions });
  }
}

const pct = (n: number, d: number) => (d === 0 ? "  -  " : `${((n / d) * 100).toFixed(0)}%`.padStart(5));

console.log(`\nCalibration over ${WINDOW_DAYS} days, ${EQUITY_UNIVERSE.length} symbols, noise floor ${FLOOR ?? "engine default"}σ₂₀`);
console.log(`theses backdated to ${createdAt.toISOString().slice(0, 10)}\n`);
console.log("type                symbols  triggered      contradicted   contradictions/symbol");
console.log("─".repeat(80));
for (const t of TYPES) {
  const r = results.get(t)!;
  const perSymbol = r.symbols ? (r.totalContradictions / r.symbols).toFixed(2) : "0";
  console.log(
    `${t.padEnd(20)}${String(r.symbols).padStart(5)}   ` +
    `${String(r.triggered).padStart(3)} ${pct(r.triggered, r.symbols)}    ` +
    `${String(r.contradicted).padStart(3)} ${pct(r.contradicted, r.symbols)}      ` +
    `${perSymbol.padStart(6)}`,
  );
}

console.log("\nSanity flags:");
for (const t of TYPES) {
  const r = results.get(t)!;
  const cRate = r.symbols ? r.contradicted / r.symbols : 0;
  const tRate = r.symbols ? r.triggered / r.symbols : 0;
  const flags: string[] = [];
  if (cRate > 0.6) flags.push(`contradicts ${(cRate * 100).toFixed(0)}% of symbols — too loose`);
  if (t !== "volatility_watch" && cRate === 0) flags.push("never contradicts — too strict or broken");
  const maintenance = t === "momentum_up" || t === "momentum_down";
  // Maintenance theses assert an ongoing state and have no trigger by design;
  // volatility_watch is meant to fire on any 2-sigma move, so broad triggering
  // is the requested behaviour rather than a defect.
  if (tRate === 0 && !maintenance) flags.push("never triggers");
  if (tRate === 1 && !maintenance && t !== "volatility_watch") flags.push("triggers on every symbol — too loose");
  if (r.symbols && r.totalContradictions / r.symbols > 3) flags.push(`${(r.totalContradictions / r.symbols).toFixed(1)} contradictions per symbol — repeating, not escalating`);
  console.log(`  ${flags.length ? "⚠ " : "✓ "}${t.padEnd(20)}${flags.join("; ") || "within expected range"}`);
}
process.exit(0);
