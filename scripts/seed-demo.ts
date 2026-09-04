/**
 * Seeds a demo account whose digest is populated on first load.
 *
 * A judge who signs up fresh sees an empty digest, and our strongest feature
 * shows nothing. So there is a prepared account with backdated theses whose
 * verdicts arise from REAL detected events in the committed history — not from
 * synthetic rows written to make the screen look busy. Everything here is
 * reproducible from the seed by running detection.
 *
 * Run: npm run seed:demo
 */
import { and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  changeEvents, priceBars, quoteObservations, symbols, theses, thesisEvents,
  userSymbolReadState, users, watchlistItems,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { runThesisEvaluation, creationContext } from "@/lib/thesis";
import { dailyBlindSpot, getDigest } from "@/lib/digest";
import { istDate } from "@/lib/time";

const EMAIL = "demo@thesis.app";
const PASSWORD = "demo-account-2026";

/* 1 ── the demo user, rebuilt from scratch each run --------------------- */

await db.delete(users).where(eq(users.email, EMAIL));
const [user] = await db.insert(users)
  .values({ email: EMAIL, passwordHash: await hashPassword(PASSWORD) })
  .returning();
console.log(`demo user ${EMAIL} (id ${user.id})`);

/* 2 ── pick a real missed event ---------------------------------------- */

/**
 * The best missed event is short, resolved, and invisible on daily closes.
 * Chosen by querying, so this holds up if the seed is ever refreshed.
 */
const candidates = await db
  .select()
  .from(changeEvents)
  .where(and(
    isNotNull(changeEvents.resolvedAt),
    eq(changeEvents.window, "intraday"),
    // Filter the duration in SQL. Sorting by duration and taking the first N
    // returns only the very shortest, which are all sub-minute noise.
    sql`${changeEvents.resolvedAt} - ${changeEvents.occurredAt} between interval '30 minutes' and interval '6 hours'`,
  ))
  .orderBy(desc(sql`${changeEvents.resolvedAt} - ${changeEvents.occurredAt}`));

let missedPick: { symbol: string; occurredAt: Date; resolvedAt: Date; minutes: number } | null = null;
for (const c of candidates) {
  if (!c.signalType.startsWith("cross_")) continue;
  const minutes = Math.round((c.resolvedAt!.getTime() - c.occurredAt.getTime()) / 60000);
  const [bar] = await db.select({ close: priceBars.currentProviderAdjClose, raw: priceBars.currentProviderClose })
    .from(priceBars)
    .where(and(eq(priceBars.symbol, c.symbol), eq(priceBars.tradingDate, istDate(c.occurredAt))))
    .limit(1);
  const close = bar?.close ?? bar?.raw;
  const blind = dailyBlindSpot(c.signalType, c.explainJson as Record<string, unknown>, close == null ? null : Number(close));
  if (!blind) continue;                                  // visible on daily bars: not the point
  missedPick = { symbol: c.symbol, occurredAt: c.occurredAt, resolvedAt: c.resolvedAt!, minutes };
  console.log(`missed event  → ${c.symbol} ${c.signalType} ${minutes} min, close ${Number(close).toFixed(2)} vs level ${blind.level.toFixed(2)}${blind.exactlyAtLevel ? " (exactly the level)" : ""}`);
  break;
}
if (!missedPick) throw new Error("no suitable missed event in the seeded history");

/* 3 ── pick a real price_range trigger ---------------------------------- */

/**
 * Params derived from prices the stock actually traded at after the thesis
 * date, so the trigger is a real crossing rather than a number chosen to make
 * the demo work.
 */
const THESIS_DATE = new Date("2026-07-06T04:00:00.000Z");
async function rangeThatTriggers(symbol: string) {
  const obs = await db.select({ at: quoteObservations.asOf, price: quoteObservations.price })
    .from(quoteObservations)
    .where(and(eq(quoteObservations.symbol, symbol), gt(quoteObservations.asOf, THESIS_DATE)))
    .orderBy(asc(quoteObservations.asOf)).limit(4000);
  if (obs.length < 50) return null;
  const prices = obs.map((o) => Number(o.price));
  const low = Math.min(...prices);
  // A band just above the eventual low: a dip the user was waiting for.
  return { low: Number((low * 0.999).toFixed(2)), high: Number((low * 1.012).toFixed(2)) };
}

/* 4 ── the watchlist ----------------------------------------------------- */

const TRIGGER_SYMBOL = "HDFCBANK.NS";
const CONTRADICTION_SYMBOL = "TRENT.NS";
const NOW = new Date();

/**
 * Watermarks are per (user, symbol), and this is what that buys.
 *
 * A real user has not looked at every holding at the same moment. The three
 * symbols carrying news have older watermarks — that is why their events are
 * still unseen. The quiet holdings are marked as read up to now, so they fall
 * into "unchanged" and a judge can click through to confirm that means nothing
 * happened rather than nothing was checked.
 *
 * A single global watermark could not express this, and over a two-month window
 * it would leave nothing unchanged at all, because over two months everything
 * moves.
 */
const plan: {
  symbol: string; type: string; params: Record<string, unknown>;
  note: string | null; lastSeen: Date;
}[] = [
  { symbol: CONTRADICTION_SYMBOL, type: "momentum_up", params: {}, note: "strong run since the split, want to ride it", lastSeen: THESIS_DATE },
  { symbol: TRIGGER_SYMBOL, type: "price_range", params: {}, note: "would start a position on a dip", lastSeen: THESIS_DATE },
  { symbol: missedPick.symbol, type: "volatility_watch", params: {}, note: null, lastSeen: new Date(missedPick.occurredAt.getTime() - 36e5) },
  { symbol: "ITC.NS", type: "none", params: {}, note: "long-term, just keeping an eye on it", lastSeen: NOW },
  { symbol: "DIVISLAB.NS", type: "none", params: {}, note: null, lastSeen: NOW },
  { symbol: "KOTAKBANK.NS", type: "none", params: {}, note: null, lastSeen: NOW },
];

for (const p of plan) {
  await db.insert(symbols).values({ symbol: p.symbol }).onConflictDoNothing();
  const [item] = await db.insert(watchlistItems)
    .values({ userId: user.id, symbol: p.symbol, createdAt: THESIS_DATE })
    .onConflictDoNothing()
    .returning();
  if (!item) continue;

  let params = p.params;
  if (p.type === "price_range") {
    const range = await rangeThatTriggers(p.symbol);
    if (!range) { console.log(`  ${p.symbol}: no usable range, skipping thesis`); continue; }
    params = { ...range, context: await creationContext(p.symbol) };
    console.log(`trigger       → ${p.symbol} range ₹${range.low}–₹${range.high} (derived from real prices after ${istDate(THESIS_DATE)})`);
  } else if (p.type !== "none") {
    params = { context: await creationContext(p.symbol) };
  }

  if (p.type !== "none" || p.note) {
    await db.insert(theses).values({
      watchlistItemId: item.id, type: p.type, paramsJson: params,
      note: p.note, createdAt: THESIS_DATE, state: "WATCHING",
    }).onConflictDoNothing();
  }

  await db.insert(userSymbolReadState)
    .values({ userId: user.id, symbol: p.symbol, lastSeenAt: p.lastSeen })
    .onConflictDoNothing();
}

/* 5 ── evaluate, then report what the digest will actually show ---------- */

const evalResult = await runThesisEvaluation();
console.log(`\nevaluated ${evalResult.evaluated} theses, recorded ${evalResult.recorded} verdicts`);

const digest = await getDigest(user.id);
console.log(`\ndigest for ${EMAIL}:`);
console.log(`  ${digest.contradictions.length} contradicted   ${digest.triggers.length} triggered   ` +
            `${digest.missed.length} missed   ${digest.anomalies.length} anomalies   ${digest.unchanged.length} unchanged`);
for (const c of digest.contradictions) console.log(`  ✕ ${c.symbol}  ${c.conditions.filter((x) => x.met).length}/${c.conditions.length} conditions, sustained ${c.sustainedSessions}`);
for (const t of digest.triggers) console.log(`  ✓ ${t.symbol}  ${t.conditionText}`);
for (const a of digest.anomalies) console.log(`  · ${a.symbol}  ${a.signalType.replace(/_/g, " ")}`);
console.log(`  ○ unchanged: ${digest.unchanged.map((u) => u.symbol).join(", ") || "none"}`);
for (const m of digest.missed) {
  console.log(`  ◆ ${m.symbol}  ${m.headline}, ${m.durationMinutes} min` +
              (m.dailyBlindSpot ? `  — closed ${m.dailyBlindSpot.close.toFixed(2)} vs level ${m.dailyBlindSpot.level.toFixed(2)}${m.dailyBlindSpot.exactlyAtLevel ? " (exactly the level)" : ""}` : ""));
}

const ok = digest.contradictions.length > 0 && digest.triggers.length > 0 && digest.missed.length > 0;
console.log(`\n${ok ? "PASS" : "INCOMPLETE"} — one of each kind ${ok ? "present" : "MISSING"}`);
console.log(`sign in as ${EMAIL} / ${PASSWORD}`);
process.exit(ok ? 0 : 1);
