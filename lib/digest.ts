import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  changeEvents, priceBars, quotes, symbols, theses, thesisEvents,
  userSymbolReadState, watchlistItems,
} from "@/db/schema";
import { lastCommittedBatchAt } from "@/lib/ingestion";
import { deriveTradingCalendar } from "@/lib/market/calendar";
import { describeSecurity, formatMoney, type Security } from "@/lib/securities";
import { indexDisplayName } from "@/lib/market-brief";
import { getUnusualSessions } from "@/lib/ml/anomaly-server";
import { exchangeDate, istDate } from "@/lib/time";
import type { Bar } from "@/lib/market/types";

/**
 * Digest composition — the personalisation layer.
 *
 * Detection ran once per symbol and knew nothing about users. This is where a
 * user enters the picture: their watchlist, their theses, their per-symbol
 * watermark. Nothing here re-derives market facts; it filters and orders facts
 * already established.
 *
 * The cutoff is the completion timestamp of the last fully-committed ingestion
 * batch, NEVER `now()`. An event whose `detectedAt` precedes `now()` but which
 * commits after the digest query runs would otherwise be skipped forever.
 */

/**
 * The longest an event can stay open and still count as MISSED.
 *
 * Containment alone is not enough. With a two-month away-window, an event that
 * stayed open for six weeks is technically "entirely inside the window", but the
 * user had forty chances to see it — they simply did not look. That is not the
 * feature.
 *
 * A genuine missed event is one nobody could have seen in its live state: it
 * opened and closed inside a single trading session, so no daily close contains
 * it either. The NSE session is 09:15–15:30 IST, 375 minutes; rounded up
 * slightly for events straddling the open or close.
 */
const MISSED_MAX_OPEN_MINUTES = 390;

/**
 * The shortest an event can be and still be worth reporting as missed.
 *
 * At 5-minute resolution a single observation above a level is a tick, not an
 * episode — and "you missed a 5-minute event" invites the obvious reply that
 * nobody was watching that closely anyway. Two consecutive observations is the
 * minimum that describes something that actually persisted and then reversed.
 */
const MISSED_MIN_OPEN_MINUTES = 10;

/**
 * At most one missed event per symbol in the digest.
 *
 * A volatile symbol can produce several reversals in a window, and showing all
 * of them buries every other holding under one name. The digest answers "what
 * deserves attention across everything you watch", so breadth beats depth here;
 * the rest remain on the symbol's own page.
 */
const MISSED_PER_SYMBOL = 1;
const MISSED_TOTAL = 4;

export type EvidenceEntry = { label: string; value: string; basis?: string };

export type ContradictionCard = {
  kind: "contradiction";
  /** The optional anomaly layer flagged this session. Context only, never a cause. */
  unusualPattern?: boolean;
  thesisId: number;
  symbol: string;
  name: string | null;
  /** Exchange, currency and clock for this security. Every card renders in its own units. */
  security: Security;
  thesisType: string;
  prompt: string;
  note: string | null;
  occurredAt: Date;
  conditions: { name: string; label: string; met: boolean; detail: string }[];
  conditionsRequired: number;
  sustainedSessions: number | null;
  evidence: EvidenceEntry[];
};

export type TriggerCard = {
  kind: "trigger";
  /** The optional anomaly layer flagged this session. Context only, never a cause. */
  unusualPattern?: boolean;
  thesisId: number;
  symbol: string;
  name: string | null;
  security: Security;
  thesisType: string;
  conditionText: string;
  note: string | null;
  occurredAt: Date;
  evidence: EvidenceEntry[];
};

export type MissedCard = {
  kind: "missed";
  /** The optional anomaly layer flagged this session. Context only, never a cause. */
  unusualPattern?: boolean;
  symbol: string;
  name: string | null;
  security: Security;
  signalType: string;
  headline: string;
  occurredAt: Date;
  resolvedAt: Date;
  durationMinutes: number;
  awayFrom: Date;
  awayUntil: Date;
  /** Computed from the actual daily bar — never asserted. Null when we cannot prove it. */
  dailyBlindSpot: { close: number; level: number; exactlyAtLevel: boolean; direction: "above" | "below" } | null;
  peak: number | null;
  evidence: EvidenceEntry[];
};

export type AnomalyCard = {
  kind: "anomaly";
  /** The optional anomaly layer flagged this session. Context only, never a cause. */
  unusualPattern?: boolean;
  symbol: string;
  name: string | null;
  security: Security;
  signalType: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  evidence: EvidenceEntry[];
};

export type Digest = {
  awayFrom: Date | null;
  cutoff: Date;
  sessionsInWindow: number;
  /** True when the away-window contains no trading session at all. */
  marketClosedThroughout: boolean;
  contradictions: ContradictionCard[];
  triggers: TriggerCard[];
  missed: MissedCard[];
  anomalies: AnomalyCard[];
  unchanged: { symbol: string; name: string | null; security: Security }[];
};

/* ------------------------------------------------------------- formatting */

const num = (v: unknown, digits = 2): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
const pct = (v: unknown, digits = 2): string =>
  typeof v === "number" && Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%` : "—";
/** Money always renders in the security's own currency — never a global rupee. */
const money = (v: unknown, currency: string | null): string =>
  typeof v === "number" && Number.isFinite(v) ? formatMoney(v, currency) : "—";

/**
 * Turns a stored explain payload into display rows.
 *
 * Reads only what detection recorded. Nothing is recomputed: the numbers a user
 * sees are the numbers that were true when the claim was made.
 */
export function evidenceFrom(explain: Record<string, unknown>, currency: string | null = "INR"): EvidenceEntry[] {
  const e: EvidenceEntry[] = [];
  const has = (k: string) => explain[k] != null;
  const price = (v: unknown) => money(v, currency);

  if (has("price")) e.push({ label: "Price", value: price(explain.price) });
  if (has("close")) e.push({ label: "Close", value: price(explain.close) });
  if (has("return_pct")) e.push({ label: "Change", value: pct(explain.return_pct) });
  if (has("gap_pct")) e.push({ label: "Gap from previous close", value: pct(explain.gap_pct) });
  if (has("z_vs_20d_realized_vol")) {
    e.push({
      label: "Move",
      value: `${num(explain.z_vs_20d_realized_vol, 1)}σ`,
      basis: "vs 20-day realized volatility",
    });
  }
  if (has("realized_vol_20d_daily")) {
    e.push({
      label: "Realized volatility",
      value: `${num((explain.realized_vol_20d_daily as number) * 100)}%`,
      basis: "daily, 20-day",
    });
  }
  if (has("level")) {
    e.push({
      label: "Level crossed",
      value: price(explain.level),
      basis: typeof explain.level_source === "string" ? explain.level_source : undefined,
    });
  }
  if (has("ma_20d")) e.push({ label: "20-day average", value: price(explain.ma_20d) });
  if (has("volume") && has("median_volume_20d")) {
    e.push({
      label: "Volume",
      value: `${num(explain.volume_vs_median ?? (explain.volume as number) / (explain.median_volume_20d as number), 1)}×`,
      basis: "of 20-day median",
    });
  }
  if (has("benchmark_return_pct")) {
    // The benchmark is whatever detection actually measured against, recorded in
    // the event. Never relabelled after the fact.
    e.push({ label: typeof explain.benchmark === "string" ? indexDisplayName(explain.benchmark) : "Benchmark", value: pct(explain.benchmark_return_pct) });
  }
  if (has("beta_60d")) {
    e.push({
      label: "Beta",
      value: num(explain.beta_60d),
      basis: typeof explain.benchmark === "string" ? `60-day, vs ${indexDisplayName(explain.benchmark)}` : "60-day, vs benchmark",
    });
  }
  if (has("expected_from_benchmark_pct")) {
    e.push({ label: "Expected from market", value: pct(explain.expected_from_benchmark_pct) });
  }
  if (has("residual_pct")) {
    e.push({ label: "Stock-specific residual", value: pct(explain.residual_pct) });
  }
  return e;
}

const CONDITION_LABELS: Record<string, string> = {
  price_below_20d_ma: "Price below 20-day average",
  price_above_20d_ma: "Price above 20-day average",
  "20d_return_negative": "20-day return negative",
  "20d_return_positive": "20-day return positive",
  residual_negative_over_20d: "Residual vs benchmark negative",
  residual_positive_over_20d: "Residual vs benchmark positive",
  residual_negative_over_10d: "Residual vs benchmark negative (10 sessions)",
  close_below_20d_ma: "Close below 20-day average",
  failed_breakout: "Failed breakout",
  price_moved_away_from_range: "Price moved away from your range",
  volatility_doubled_since_creation: "Volatility doubled since you wrote this",
  "benchmark_relative_residual_below_-5pct": "Residual vs benchmark below −5%",
  volume_below_median_for_3_sessions: "Volume below median, 3 sessions",
  price_unchanged_within_1pct: "Price unchanged within 1%",
};

function conditionDetail(c: Record<string, unknown>): string {
  if (c.close != null && c.ma_20d != null) return `${num(c.close)}  vs  ${num(c.ma_20d)}`;
  if (c.return_20d_pct != null) return `${pct(c.return_20d_pct, 1)}   floor ${pct(-(c.noise_floor_pct as number), 1)}`;
  if (c.residual_20d_pct != null) return `${pct(c.residual_20d_pct, 1)}   floor ${pct(-(c.noise_floor_pct as number), 1)}`;
  if (c.residual_10d_pct != null) return `${pct(c.residual_10d_pct, 1)}`;
  if (c.realized_vol_20d_now != null && c.realized_vol_20d_at_creation != null) {
    return `${num((c.realized_vol_20d_now as number) * 100)}%  vs  ${num((c.realized_vol_20d_at_creation as number) * 100)}% at creation`;
  }
  if (c.distance_beyond_range != null) return `${num(c.distance_beyond_range)} beyond range`;
  if (c.change_pct != null) return pct(c.change_pct, 1);
  return "";
}

/* ------------------------------------------------ daily-bar blind spot ---- */

/**
 * Whether an intraday event would have been visible on daily closes.
 *
 * Computed from the actual daily bar for that session, never asserted. This is
 * the strongest claim the product makes — "on daily closes this would not appear
 * at all" — so it has to be earned per event, for whatever symbol a user happens
 * to be watching, and withheld when we cannot prove it.
 */
export function dailyBlindSpot(
  signalType: string,
  explain: Record<string, unknown>,
  dailyClose: number | null,
): { close: number; level: number; exactlyAtLevel: boolean; direction: "above" | "below" } | null {
  const level = explain.level ?? explain.ma_20d;
  if (typeof level !== "number" || !Number.isFinite(level)) return null;
  if (dailyClose == null || !Number.isFinite(dailyClose)) return null;

  const isUpward = signalType.includes("high") || signalType.includes("above");
  const isDownward = signalType.includes("low") || signalType.includes("below");
  if (!isUpward && !isDownward) return null;

  // The condition the intraday path satisfied. If the CLOSE does not satisfy it,
  // a daily-bar implementation sees nothing.
  const closeSatisfies = isUpward ? dailyClose > level : dailyClose < level;
  if (closeSatisfies) return null;

  return {
    close: dailyClose,
    level,
    exactlyAtLevel: Math.abs(dailyClose - level) < 0.005,
    // Which way the intraday path crossed. The close therefore came back the
    // OTHER way, and saying "back below" about a close that is above the level
    // is the kind of detail that costs a reader their trust in everything else.
    direction: isUpward ? "above" : "below",
  };
}

const SIGNAL_HEADLINES: Record<string, string> = {
  cross_52w_high: "52-week high",
  cross_52w_low: "52-week low",
  cross_20d_high: "20-day high",
  cross_20d_low: "20-day low",
  trend_above_ma20: "crossed above its 20-day average",
  trend_below_ma20: "crossed below its 20-day average",
  price_move: "unusually large move",
  volume_anomaly: "unusual volume",
  benchmark_residual: "moved independently of the market",
  overnight_gap: "gapped at the open",
};

/* ------------------------------------------------------------- the digest */

export async function getDigest(userId: number): Promise<Digest> {
  const cutoff = (await lastCommittedBatchAt()) ?? new Date();

  const items = await db
    .select({
      itemId: watchlistItems.id,
      symbol: watchlistItems.symbol,
      addedAt: watchlistItems.createdAt,
      name: symbols.name,
      exchange: symbols.exchange,
      currency: symbols.currency,
      timeZone: symbols.exchangeTimezone,
      thesisId: theses.id,
      thesisType: theses.type,
      thesisNote: theses.note,
      thesisParams: theses.paramsJson,
      watermark: userSymbolReadState.lastSeenAt,
    })
    .from(watchlistItems)
    .innerJoin(symbols, eq(symbols.symbol, watchlistItems.symbol))
    .leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
    .leftJoin(
      userSymbolReadState,
      and(eq(userSymbolReadState.userId, userId), eq(userSymbolReadState.symbol, watchlistItems.symbol)),
    )
    .where(eq(watchlistItems.userId, userId))
    .orderBy(asc(watchlistItems.createdAt));

  const empty: Digest = {
    awayFrom: null, cutoff, sessionsInWindow: 0, marketClosedThroughout: false,
    contradictions: [], triggers: [], missed: [], anomalies: [], unchanged: [],
  };
  if (items.length === 0) return empty;

  // Exchange, currency and clock per watched security, resolved once. Every card
  // below renders through this rather than through a global assumption.
  const securityFor = new Map(items.map((i) => [i.symbol, describeSecurity({
    symbol: i.symbol, name: i.name, exchange: i.exchange, currency: i.currency, timeZone: i.timeZone,
  })]));

  // A new symbol's watermark is when it was added — we do not replay three
  // months of history at someone who just started watching.
  const watermarkFor = new Map(items.map((i) => [i.symbol, i.watermark ?? i.addedAt]));
  const awayFrom = new Date(Math.min(...items.map((i) => (watermarkFor.get(i.symbol) ?? i.addedAt).getTime())));
  const symbolList = items.map((i) => i.symbol);

  const bars = await db
    .select({
      symbol: priceBars.symbol, date: priceBars.tradingDate,
      close: priceBars.currentProviderClose, adjClose: priceBars.currentProviderAdjClose,
      volume: priceBars.currentProviderVolume,
    })
    .from(priceBars).where(inArray(priceBars.symbol, symbolList));

  const closeByKey = new Map<string, number>();
  const barsBySymbol = new Map<string, Bar[]>();
  for (const b of bars) {
    const close = b.adjClose == null ? (b.close == null ? null : Number(b.close)) : Number(b.adjClose);
    if (close != null) closeByKey.set(`${b.symbol}|${b.date}`, close);
    const list = barsBySymbol.get(b.symbol) ?? [];
    list.push({
      date: b.date, open: null, high: null, low: null,
      close: b.close == null ? null : Number(b.close),
      adjClose: b.adjClose == null ? null : Number(b.adjClose),
      volume: b.volume == null ? null : Number(b.volume),
    });
    barsBySymbol.set(b.symbol, list);
  }

  // "Market closed since your last visit" is a different statement from "no
  // changes", and the calendar is derived from observed bars rather than a
  // hardcoded holiday list.
  //
  // Across a mixed watchlist this is a session COUNT over the union of the
  // markets watched, bounded by IST dates — it is a sentence about the window,
  // not an input to any verdict. Nothing downstream branches on it, so an
  // Indian-holiday/US-session edge date shifts a count by one rather than
  // changing what the digest reports.
  // Secondary evidence, fetched last and allowed to fail: the digest is a
  // deterministic product and must render identically without it.
  const unusual = await getUnusualSessions(symbolList, istDate(new Date(awayFrom.getTime() - 3 * 864e5)))
    .catch(() => new Map<string, import("@/lib/ml/anomaly-server").StoredAnomaly>());
  const flagged = (symbol: string, at: Date, security: Security) =>
    unusual.has(`${symbol}|${exchangeDate(at, security.timeZone)}`) || undefined;

  const calendar = deriveTradingCalendar([...barsBySymbol.values()]);
  const fromDate = istDate(awayFrom);
  const untilDate = istDate(cutoff);
  const sessionsInWindow = [...calendar].filter((d) => d > fromDate && d <= untilDate).length;

  /* ---- 1. contradictions, 2. triggers ---------------------------------- */

  const thesisIds = items.map((i) => i.thesisId).filter((id): id is number => id != null);
  const tEvents = thesisIds.length
    ? await db.select().from(thesisEvents)
        .where(and(inArray(thesisEvents.thesisId, thesisIds), gte(thesisEvents.occurredAt, awayFrom)))
        .orderBy(desc(thesisEvents.occurredAt))
    : [];

  const itemByThesis = new Map(items.filter((i) => i.thesisId).map((i) => [i.thesisId!, i]));
  const contradictions: ContradictionCard[] = [];
  const triggers: TriggerCard[] = [];
  const seenThesis = new Set<number>();

  for (const ev of tEvents) {
    if (seenThesis.has(ev.thesisId)) continue;      // most recent verdict per thesis
    const item = itemByThesis.get(ev.thesisId);
    if (!item) continue;
    // Against THIS symbol's watermark, not the global one. The query above uses
    // the earliest watermark across the watchlist purely to bound its scan; the
    // decision about whether a user has already seen something is per-symbol,
    // which is the entire reason the watermark is keyed that way.
    if (ev.occurredAt.getTime() < (watermarkFor.get(item.symbol) ?? awayFrom).getTime()) continue;
    seenThesis.add(ev.thesisId);

    const evidence = ev.evidenceJson as Record<string, unknown>;
    const params = (item.thesisParams ?? {}) as Record<string, number>;
    const security = securityFor.get(item.symbol)!;

    if (ev.kind === "contradicted") {
      const raw = (evidence.conditions ?? []) as Record<string, unknown>[];
      contradictions.push({
        kind: "contradiction",
        thesisId: ev.thesisId,
        symbol: item.symbol,
        name: item.name,
        security,
        thesisType: item.thesisType ?? "none",
        prompt: promptFor(item.thesisType ?? "none"),
        note: item.thesisNote,
        occurredAt: ev.occurredAt,
        conditionsRequired: Number(evidence.conditions_required ?? 2),
        sustainedSessions: typeof evidence.sustained_for_sessions === "number" ? evidence.sustained_for_sessions : null,
        conditions: raw.map((c) => ({
          name: String(c.name),
          label: CONDITION_LABELS[String(c.name)] ?? String(c.name).replace(/_/g, " "),
          met: Boolean(c.met),
          detail: conditionDetail(c),
        })),
        evidence: evidenceFrom(evidence, security.currency),
        unusualPattern: flagged(item.symbol, ev.occurredAt, security),
      });
    } else if (ev.kind === "triggered") {
      triggers.push({
        kind: "trigger",
        thesisId: ev.thesisId,
        symbol: item.symbol,
        name: item.name,
        security,
        thesisType: item.thesisType ?? "none",
        conditionText: conditionTextFor(item.thesisType ?? "none", params, security.currency),
        note: item.thesisNote,
        occurredAt: ev.occurredAt,
        evidence: evidenceFrom(evidence, security.currency),
        unusualPattern: flagged(item.symbol, ev.occurredAt, security),
      });
    }
  }

  /* ---- 3. missed events, 4. anomalies ---------------------------------- */

  const cEvents = await db
    .select().from(changeEvents)
    .where(and(
      inArray(changeEvents.symbol, symbolList),
      gte(changeEvents.occurredAt, awayFrom),
      lte(changeEvents.occurredAt, cutoff),
    ))
    .orderBy(desc(changeEvents.score));

  // Collected first, ranked second, capped third. Capping during collection let
  // a higher-scoring event take a symbol's only slot before the one that is
  // provably invisible on daily closes was even considered — which is exactly
  // the event worth showing.
  const missedAll: MissedCard[] = [];
  const anomalies: AnomalyCard[] = [];
  const noteworthy = new Set<string>();

  for (const ev of cEvents) {
    const item = items.find((i) => i.symbol === ev.symbol);
    if (!item) continue;
    const explain = ev.explainJson as Record<string, unknown>;
    const security = securityFor.get(ev.symbol)!;
    const watermark = watermarkFor.get(ev.symbol)!;
    // Same rule for change events: seen is a per-symbol fact.
    if (ev.occurredAt.getTime() < watermark.getTime()) continue;

    // A missed event: fired AND reversed entirely inside the away-window, and
    // short enough that the user could never have seen it in its live state.
    const openMinutes = ev.resolvedAt == null
      ? Infinity
      : (ev.resolvedAt.getTime() - ev.occurredAt.getTime()) / 60000;
    const isMissed =
      ev.resolvedAt != null &&
      ev.occurredAt.getTime() >= watermark.getTime() &&
      ev.resolvedAt.getTime() <= cutoff.getTime() &&
      openMinutes >= MISSED_MIN_OPEN_MINUTES &&
      openMinutes <= MISSED_MAX_OPEN_MINUTES;

    if (isMissed) {
      // Which session an intraday event belongs to is an exchange-local fact: a
      // NASDAQ event at 19:00 UTC is that day's session, and dating it in IST
      // would look up the wrong daily bar entirely.
      const date = exchangeDate(ev.occurredAt, security.timeZone);
      const close = closeByKey.get(`${ev.symbol}|${date}`) ?? null;
      missedAll.push({
        kind: "missed",
        symbol: ev.symbol,
        name: item.name,
        security,
        signalType: ev.signalType,
        headline: SIGNAL_HEADLINES[ev.signalType] ?? ev.signalType.replace(/_/g, " "),
        occurredAt: ev.occurredAt,
        resolvedAt: ev.resolvedAt!,
        durationMinutes: Math.round((ev.resolvedAt!.getTime() - ev.occurredAt.getTime()) / 60000),
        awayFrom: watermark,
        awayUntil: cutoff,
        dailyBlindSpot: dailyBlindSpot(ev.signalType, explain, close),
        peak: typeof explain.price === "number" ? explain.price : null,
        evidence: evidenceFrom(explain, security.currency),
        unusualPattern: flagged(ev.symbol, ev.occurredAt, security),
      });
      noteworthy.add(ev.symbol);
      continue;
    }

    // Generic anomalies, but only for symbols with no thesis of their own —
    // a thesis is a better filter than a raw anomaly.
    const hasThesis = item.thesisType != null && item.thesisType !== "none";
    if (!hasThesis && anomalies.length < 6 && !noteworthy.has(ev.symbol)) {
      anomalies.push({
        kind: "anomaly",
        symbol: ev.symbol,
        name: item.name,
        security,
        signalType: ev.signalType,
        occurredAt: ev.occurredAt,
        resolvedAt: ev.resolvedAt,
        evidence: evidenceFrom(explain, security.currency),
        unusualPattern: flagged(ev.symbol, ev.occurredAt, security),
      });
      noteworthy.add(ev.symbol);
    }
  }

  // Provably invisible on daily closes first, then most transient. The blind-spot
  // events are the ones that demonstrate what the feature is for.
  missedAll.sort((a, b) => {
    const proof = Number(b.dailyBlindSpot != null) - Number(a.dailyBlindSpot != null);
    // Within the provable ones, LONGER is more persuasive: a level held for two
    // hours and then given back is an episode a user would have wanted to know
    // about. Ranking by shortest first surfaced single-tick blips instead.
    return proof !== 0 ? proof : b.durationMinutes - a.durationMinutes;
  });
  const missed: MissedCard[] = [];
  for (const m of missedAll) {
    if (missed.length >= MISSED_TOTAL) break;
    if (missed.filter((x) => x.symbol === m.symbol).length >= MISSED_PER_SYMBOL) continue;
    missed.push(m);
  }

  for (const c of contradictions) noteworthy.add(c.symbol);
  for (const t of triggers) noteworthy.add(t.symbol);

  const unchanged = items
    .filter((i) => !noteworthy.has(i.symbol))
    .map((i) => ({ symbol: i.symbol, name: i.name, security: securityFor.get(i.symbol)! }));

  return {
    awayFrom,
    cutoff,
    sessionsInWindow,
    marketClosedThroughout: sessionsInWindow === 0,
    contradictions,
    triggers,
    missed,
    anomalies,
    unchanged,
  };
}

function promptFor(type: string): string {
  return {
    price_range: "Waiting for a dip",
    breakout: "Watching for a breakout",
    momentum_up: "Tracking momentum",
    momentum_down: "Tracking a decline",
    volatility_watch: "Watching for unusual moves",
    volume_expansion: "Watching for volume expansion",
    none: "Just watching",
  }[type] ?? type;
}

function conditionTextFor(type: string, params: Record<string, number>, currency: string | null): string {
  if (type === "price_range" && params.low != null && params.high != null) {
    return `between ${money(params.low, currency)} and ${money(params.high, currency)}`;
  }
  if (type === "breakout" && params.level != null) return `a breakout above ${money(params.level, currency)}`;
  return promptFor(type).toLowerCase();
}

/**
 * Advances the watermark, monotonically.
 *
 * GREATEST, never a blind overwrite: two open tabs is a real race, and a stale
 * tab committing an older timestamp would silently resurface news the user has
 * already seen. Called on dismiss, never on render — "seen" and "acknowledged"
 * are different things, and a refresh must not empty the page.
 */
export async function advanceWatermark(userId: number, symbols_: string[], to: Date): Promise<void> {
  if (symbols_.length === 0) return;
  for (const symbol of symbols_) {
    await db.insert(userSymbolReadState)
      .values({ userId, symbol, lastSeenAt: to })
      .onConflictDoUpdate({
        target: [userSymbolReadState.userId, userSymbolReadState.symbol],
        set: { lastSeenAt: sql`greatest(${userSymbolReadState.lastSeenAt}, excluded.last_seen_at)` },
      });
  }
}

/** Marks the current completed-ingestion snapshot read for every symbol a user watches. */
export async function advanceDigestWatermark(userId: number, to: Date): Promise<void> {
  const items = await db
    .select({ symbol: watchlistItems.symbol })
    .from(watchlistItems)
    .where(eq(watchlistItems.userId, userId));
  await advanceWatermark(userId, items.map((item) => item.symbol), to);
}
