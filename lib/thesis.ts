import "server-only";
import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  changeEvents, corporateActions, priceBars, quoteObservations, symbolStats, theses,
  thesisEvents, userSymbolReadState, watchlistItems,
} from "@/db/schema";
import { evaluateThesis, resolveState, type ThesisParams, type ThesisType } from "@/lib/thesis-engine";
import { BENCHMARK } from "@/lib/universe";
import type { Bar } from "@/lib/market/types";

/** Persistence and lifecycle for theses. Evaluation itself is pure, in thesis-engine.ts. */

export const THESIS_TYPES: { value: ThesisType; prompt: string; needsParams: "range" | "level" | null }[] = [
  { value: "price_range", prompt: "Waiting for a dip", needsParams: "range" },
  { value: "breakout", prompt: "Watching for a breakout", needsParams: "level" },
  { value: "momentum_up", prompt: "Tracking momentum", needsParams: null },
  { value: "volatility_watch", prompt: "Watching for unusual moves", needsParams: null },
  { value: "none", prompt: "Just watching", needsParams: null },
];

async function loadBars(symbol: string): Promise<Bar[]> {
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

/**
 * Captures the conditions in force when a thesis is written.
 *
 * Several contradiction rules are relative to creation — "volatility above twice
 * its level at creation" is meaningless unless that level was recorded at the
 * time. Computing it later from current data would silently change what the
 * user's thesis meant.
 */
export async function creationContext(symbol: string): Promise<ThesisParams["context"]> {
  const bars = await loadBars(symbol);
  const closes = bars.map((b) => b.adjClose ?? b.close).filter((c): c is number => c != null && c > 0);
  if (closes.length < 3) return {};
  const window = closes.slice(-21);
  const rets: number[] = [];
  for (let i = 1; i < window.length; i++) rets.push(Math.log(window[i] / window[i - 1]));
  const usable = rets.filter(Number.isFinite);
  const m = usable.reduce((a, b) => a + b, 0) / usable.length;
  const vol = usable.length > 1
    ? Math.sqrt(usable.reduce((a, r) => a + (r - m) ** 2, 0) / (usable.length - 1))
    : undefined;
  return { priceAtCreation: closes[closes.length - 1], realizedVolAtCreation: vol };
}

export type CreateThesisInput = {
  watchlistItemId: number;
  type: ThesisType;
  params: ThesisParams;
  note: string | null;
};

export async function createThesis(input: CreateThesisInput): Promise<void> {
  await db.insert(theses).values({
    watchlistItemId: input.watchlistItemId,
    type: input.type,
    paramsJson: input.params,
    note: input.note,
    state: "WATCHING",
  }).onConflictDoUpdate({
    target: theses.watchlistItemId,
    set: {
      type: input.type,
      paramsJson: input.params,
      note: input.note,
      state: "WATCHING",
      // Editing a thesis restarts it: a new belief cannot inherit the evidence
      // gathered against the previous one.
      createdAt: new Date(),
      lastAcknowledgedAt: null,
    },
  });
}

/**
 * Evaluates every thesis and records the verdicts.
 *
 * Append-only, on the same discipline as change_events: a verdict is written
 * once and never rewritten, so the evidence a user was shown stays the evidence
 * that was true when we showed it.
 */
export async function runThesisEvaluation(): Promise<{ evaluated: number; recorded: number }> {
  const rows = await db
    .select({
      id: theses.id, type: theses.type, params: theses.paramsJson, createdAt: theses.createdAt,
      lastAcknowledgedAt: theses.lastAcknowledgedAt, symbol: watchlistItems.symbol,
    })
    .from(theses)
    .innerJoin(watchlistItems, eq(watchlistItems.id, theses.watchlistItemId));

  if (rows.length === 0) return { evaluated: 0, recorded: 0 };

  const benchmarkBars = await loadBars(BENCHMARK);
  const bySymbol = new Map<string, { bars: Bar[]; obs: { at: Date; price: number }[]; anomalies: { occurredAt: Date; magnitude: number; signalType: string }[]; beta: number | null }>();

  for (const symbol of new Set(rows.map((r) => r.symbol))) {
    const [stats] = await db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1);
    bySymbol.set(symbol, {
      bars: await loadBars(symbol),
      obs: (await db.select({ at: quoteObservations.asOf, price: quoteObservations.price })
        .from(quoteObservations).where(eq(quoteObservations.symbol, symbol))
        .orderBy(asc(quoteObservations.asOf))).map((r) => ({ at: r.at, price: Number(r.price) })),
      anomalies: (await db.select({
          occurredAt: changeEvents.occurredAt, magnitude: changeEvents.magnitude, signalType: changeEvents.signalType,
        }).from(changeEvents).where(eq(changeEvents.symbol, symbol)))
        .map((r) => ({ occurredAt: r.occurredAt, magnitude: Number(r.magnitude), signalType: r.signalType })),
      beta: stats?.beta60 == null ? null : Number(stats.beta60),
    });
  }

  let recorded = 0;
  for (const t of rows) {
    const ctx = bySymbol.get(t.symbol)!;
    const prior = await db.select({ kind: thesisEvents.kind, occurredAt: thesisEvents.occurredAt })
      .from(thesisEvents).where(eq(thesisEvents.thesisId, t.id));

    const verdicts = evaluateThesis({
      type: t.type as ThesisType,
      params: t.params as ThesisParams,
      createdAt: t.createdAt,
      lastAcknowledgedAt: t.lastAcknowledgedAt,
      priorEvents: prior,
      dailyBars: ctx.bars,
      benchmarkBars,
      observations: ctx.obs,
      anomalies: ctx.anomalies,
      beta: ctx.beta,
    });

    for (const v of verdicts) {
      const res = await db.insert(thesisEvents).values({
        thesisId: t.id, kind: v.kind, occurredAt: v.occurredAt,
        conditionsMetJson: v.conditionsMet, evidenceJson: v.evidence,
      }).onConflictDoNothing({ target: [thesisEvents.thesisId, thesisEvents.kind, thesisEvents.occurredAt] })
        .returning({ id: thesisEvents.id });
      if (res.length) recorded++;
    }

    await db.update(theses)
      .set({ state: resolveState(t.type as ThesisType, verdicts, t.lastAcknowledgedAt) })
      .where(eq(theses.id, t.id));
  }

  return { evaluated: rows.length, recorded };
}

/**
 * User actions on a thesis.
 *
 * Acknowledgement resets state to WATCHING and restarts the minimum observation
 * window, so a thesis the user has looked at cannot immediately re-contradict on
 * the same evidence.
 */
export async function acknowledgeThesis(userId: number, thesisId: number): Promise<void> {
  const now = new Date();
  const owned = db.select({ id: theses.id }).from(theses)
    .innerJoin(watchlistItems, eq(watchlistItems.id, theses.watchlistItemId))
    .where(and(eq(theses.id, thesisId), eq(watchlistItems.userId, userId)));

  await db.update(theses)
    .set({ state: "WATCHING", lastAcknowledgedAt: now })
    .where(inArray(theses.id, owned));

  await db.update(thesisEvents)
    .set({ acknowledgedAt: now })
    .where(and(eq(thesisEvents.thesisId, thesisId), sql`${thesisEvents.acknowledgedAt} is null`));
}

/* --------------------------------------------- corporate-action adjustment */

/**
 * Applies a validated corporate action to the numbers a USER typed.
 *
 * This is the half of corporate-action handling that actually matters. Provider
 * history restates itself, so our price series is internally consistent without
 * any help. What cannot restate itself is everything we store on the user's
 * behalf: a thesis that says "interested below ₹2,800" and a watermark price of
 * ₹2,750. After a 1:5 split those are wrong by a factor of five — and wrong in
 * the worst direction, because the stale ₹2,800 fires immediately and looks like
 * a real trigger.
 *
 * Detection without this is worse than no detection: we would know the numbers
 * had become wrong and let them fire anyway.
 *
 * Nothing is silently rewritten. The prior values are kept on the thesis under
 * `adjustments`, `paramsAdjustedAt` is set, and the UI shows both.
 */
export async function applyCorporateActions(): Promise<{ applied: number; thesesAdjusted: number; watermarksAdjusted: number }> {
  const pending = await db
    .select()
    .from(corporateActions)
    .where(and(eq(corporateActions.status, "VALIDATED"), isNull(corporateActions.appliedAt)));

  let thesesAdjusted = 0;
  let watermarksAdjusted = 0;

  for (const action of pending) {
    const factor = action.factor == null ? null : Number(action.factor);
    if (factor == null || !Number.isFinite(factor) || factor <= 0) continue;

    const affected = await db
      .select({ id: theses.id, params: theses.paramsJson, createdAt: theses.createdAt })
      .from(theses)
      .innerJoin(watchlistItems, eq(watchlistItems.id, theses.watchlistItemId))
      .where(eq(watchlistItems.symbol, action.symbol));

    const now = new Date();
    for (const t of affected) {
      // A thesis written AFTER the restatement already used post-split prices.
      if (action.affectedTo && t.createdAt > new Date(`${action.affectedTo}T23:59:59Z`)) continue;

      const params = { ...(t.params as Record<string, unknown>) };
      const before: Record<string, number> = {};
      let changed = false;
      for (const key of ["low", "high", "level"] as const) {
        const v = params[key];
        if (typeof v === "number" && Number.isFinite(v)) {
          before[key] = v;
          params[key] = Number((v * factor).toFixed(4));
          changed = true;
        }
      }
      if (!changed) continue;

      const history = Array.isArray(params.adjustments) ? params.adjustments as unknown[] : [];
      params.adjustments = [...history, {
        at: now.toISOString(),
        reason: action.candidateType,
        factor,
        affectedFrom: action.affectedFrom,
        affectedTo: action.affectedTo,
        before,
        after: Object.fromEntries(Object.keys(before).map((k) => [k, params[k]])),
      }];

      await db.update(theses)
        .set({ paramsJson: params, paramsAdjustedAt: now })
        .where(eq(theses.id, t.id));
      thesesAdjusted++;
    }

    // The user's personal baseline moves by the same factor, or their sense of
    // "since I last looked" is silently wrong by the split ratio.
    const updated = await db.update(userSymbolReadState)
      .set({
        lastSeenPriceAdj: sql`round(${userSymbolReadState.lastSeenPriceAdj} * ${factor}, 4)`,
        priceAdjustedAt: now,
      })
      .where(and(
        eq(userSymbolReadState.symbol, action.symbol),
        isNotNull(userSymbolReadState.lastSeenPriceAdj),
      ))
      .returning({ userId: userSymbolReadState.userId });
    watermarksAdjusted += updated.length;

    await db.update(corporateActions)
      .set({ appliedAt: now })
      .where(eq(corporateActions.id, action.id));
  }

  return { applied: pending.length, thesesAdjusted, watermarksAdjusted };
}
