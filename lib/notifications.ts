import "server-only";
import { cache } from "react";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  changeEvents, notificationPreferences, notifications, theses, thesisEvents,
  userSymbolReadState, watchlistItems,
} from "@/db/schema";
import { CONDITION_LABELS, MISSED_MAX_OPEN_MINUTES, MISSED_MIN_OPEN_MINUTES } from "@/lib/digest";
import { signalLabel } from "@/lib/recorded-evidence";
import { thesisHealth, type ThesisHealth, type ThesisHealthView } from "@/lib/thesis-health";
import { currentDataMode } from "@/lib/ml/anomaly-server";

/**
 * Notifications, generated from evidence this product already committed.
 *
 * WHY SOMETHING IS HERE. THESIS is an attention tool, so the only question a
 * notification may answer is "why should I look at this". "RELIANCE fell 3.2%"
 * answers a different question and is never generated: a price move reaches this
 * file only after the deterministic engine has already decided it meant
 * something for a condition somebody wrote down.
 *
 * IDEMPOTENT BY CONSTRUCTION. Every row names the committed row it came from,
 * and the unique index over (user, type, sourceKind, sourceId) is the only
 * de-duplication that exists. Generation can therefore run whenever it is
 * convenient — it is an insert that mostly does nothing.
 *
 * OFF THE NAVIGATION PATH. Nothing here is called while a page renders. The
 * notification centre fetches after mount, which is where generation happens.
 */

/**
 * An additive feature must not take the product down before its migration runs.
 *
 * Narrowly scoped on purpose: only "relation does not exist" is absorbed, and
 * only into the empty answer. Anything else is a real fault and is rethrown, so
 * this cannot become a place where genuine errors go quiet.
 */
const MISSING_TABLE = "42P01";

/** Drizzle wraps the driver error, so the SQLSTATE is one or more causes down. */
function isMissingTable(error: unknown): boolean {
  for (let current = error, depth = 0; current != null && depth < 5; depth++) {
    if (typeof current !== "object") return false;
    if ((current as { code?: string }).code === MISSING_TABLE) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function whenReady<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try { return await work(); }
  catch (error) { if (isMissingTable(error)) return fallback; throw error; }
}

export type NotificationType =
  | "CONDITION_TRIGGERED"
  | "THESIS_MATERIALLY_WEAKENED"
  | "THESIS_INVALIDATED"
  | "TRIGGER_REVERSED"
  | "MISSED_EVENT";

export type NotificationPreferences = {
  inApp: boolean;
  onTrigger: boolean;
  onNeedsAttention: boolean;
  onWeakened: boolean;
  onInvalidated: boolean;
  onReversal: boolean;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  inApp: true, onTrigger: true, onNeedsAttention: true,
  onWeakened: true, onInvalidated: true, onReversal: true,
};

/** Which preference gates which type. One table, so the UI cannot drift from it. */
const GATE: Record<NotificationType, keyof NotificationPreferences> = {
  CONDITION_TRIGGERED: "onTrigger",
  THESIS_MATERIALLY_WEAKENED: "onWeakened",
  THESIS_INVALIDATED: "onInvalidated",
  TRIGGER_REVERSED: "onReversal",
  MISSED_EVENT: "onReversal",
};

export type NotificationRow = {
  id: number;
  symbol: string;
  type: NotificationType;
  health: ThesisHealth | null;
  reason: string;
  link: string;
  occurredAt: Date;
  readAt: Date | null;
};

/* ------------------------------------------------------------------ health */

export type SymbolHealth = ThesisHealthView & { symbol: string; thesisType: string };

/**
 * Health for every structured thesis this user holds, from stored rows only.
 *
 * Two reads: the theses, and their verdicts. Nothing is recomputed and no
 * provider is touched, so this is safe to render inside a page.
 */
export const getThesisHealth = cache(async function getThesisHealth(userId: number): Promise<Map<string, SymbolHealth>> {
  const rows = await db
    .select({ id: theses.id, symbol: watchlistItems.symbol, type: theses.type, state: theses.state })
    .from(watchlistItems)
    .innerJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
    .where(eq(watchlistItems.userId, userId));
  const structured = rows.filter((row) => row.type && row.type !== "none");
  if (structured.length === 0) return new Map();

  const verdicts = await db
    .select({ thesisId: thesisEvents.thesisId, kind: thesisEvents.kind, occurredAt: thesisEvents.occurredAt })
    .from(thesisEvents)
    .where(inArray(thesisEvents.thesisId, structured.map((row) => row.id)));

  const health = new Map<string, SymbolHealth>();
  for (const row of structured) {
    const view = thesisHealth({
      type: row.type,
      state: row.state,
      verdicts: verdicts.filter((verdict) => verdict.thesisId === row.id),
    });
    if (view) health.set(row.symbol, { ...view, symbol: row.symbol, thesisType: row.type });
  }
  return health;
});

/* -------------------------------------------------------------- generation */

/** A candidate, before preferences and before the database decides it is new. */
type Candidate = {
  symbol: string; type: NotificationType; health: ThesisHealth | null;
  reason: string; link: string; sourceKind: "thesis_event" | "change_event";
  sourceId: number; occurredAt: Date;
};

const evidence = (value: unknown) => (value ?? {}) as Record<string, unknown>;

/** The user's own words for what they set, when the verdict recorded them. */
function conditionText(evidenceJson: unknown): string | null {
  const value = evidence(evidenceJson).your_condition;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function conditionsHeld(conditionsMet: unknown): string {
  const names = Array.isArray(conditionsMet) ? conditionsMet.filter((n): n is string => typeof n === "string") : [];
  const labels = names.map((name) => (CONDITION_LABELS[name] ?? name.replace(/_/g, " ")).toLowerCase());
  return labels.length ? labels.join(" and ") : "the recorded conditions";
}

/**
 * Everything worth telling this user about, derived from committed rows.
 *
 * Deliberately narrow. A thesis verdict is the only thing that can produce a
 * thesis notification, and a change event produces one only where the user
 * actually watches the symbol and could not have seen it live.
 */
async function candidates(userId: number): Promise<Candidate[]> {
  const health = await getThesisHealth(userId);
  const [verdicts, reversals] = await Promise.all([
    db.select({
        id: thesisEvents.id, symbol: watchlistItems.symbol, kind: thesisEvents.kind,
        occurredAt: thesisEvents.occurredAt, conditionsMet: thesisEvents.conditionsMetJson,
        evidenceJson: thesisEvents.evidenceJson,
      })
      .from(watchlistItems)
      .innerJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
      .innerJoin(thesisEvents, eq(thesisEvents.thesisId, theses.id))
      .where(eq(watchlistItems.userId, userId))
      .orderBy(desc(thesisEvents.occurredAt)).limit(50),
    // A detected event on a watched company that opened and closed again, after
    // the last time this user looked at that company. Bounded by the same
    // duration window the digest uses, so the two surfaces cannot disagree.
    db.select({
        id: changeEvents.id, symbol: changeEvents.symbol, signalType: changeEvents.signalType,
        occurredAt: changeEvents.occurredAt, resolvedAt: changeEvents.resolvedAt,
      })
      .from(watchlistItems)
      .innerJoin(changeEvents, eq(changeEvents.symbol, watchlistItems.symbol))
      .leftJoin(userSymbolReadState, and(
        eq(userSymbolReadState.userId, watchlistItems.userId),
        eq(userSymbolReadState.symbol, watchlistItems.symbol)))
      .where(and(
        eq(watchlistItems.userId, userId),
        isNotNull(changeEvents.resolvedAt),
        sql`${changeEvents.occurredAt} >= coalesce(${userSymbolReadState.lastSeenAt}, ${watchlistItems.createdAt})`))
      .orderBy(desc(changeEvents.occurredAt)).limit(50),
  ]);

  const out: Candidate[] = [];
  for (const verdict of verdicts) {
    const current = health.get(verdict.symbol);
    const link = `/symbol/${encodeURIComponent(verdict.symbol)}`;
    if (verdict.kind === "triggered") {
      const condition = conditionText(verdict.evidenceJson);
      out.push({
        symbol: verdict.symbol, type: "CONDITION_TRIGGERED", health: current?.health ?? null,
        reason: condition
          ? `The condition you set — ${condition} — was met.`
          : "The condition you set was met.",
        link, sourceKind: "thesis_event", sourceId: verdict.id, occurredAt: verdict.occurredAt,
      });
    }
    if (verdict.kind === "contradicted") {
      const held = conditionsHeld(verdict.conditionsMet);
      // Which of the two contradiction notifications applies is decided by the
      // health this thesis has NOW, so acknowledging one does not replay it.
      if (current?.health === "INVALIDATED") {
        out.push({
          symbol: verdict.symbol, type: "THESIS_INVALIDATED", health: "INVALIDATED",
          reason: `Your condition was contradicted: ${held} held together across consecutive sessions.`,
          link, sourceKind: "thesis_event", sourceId: verdict.id, occurredAt: verdict.occurredAt,
        });
      }
      if (current?.health === "MATERIALLY_WEAKENED") {
        out.push({
          symbol: verdict.symbol, type: "THESIS_MATERIALLY_WEAKENED", health: "MATERIALLY_WEAKENED",
          reason: `You acknowledged a contradiction here — ${held} — and nothing has met your condition since.`,
          link, sourceKind: "thesis_event", sourceId: verdict.id, occurredAt: verdict.occurredAt,
        });
      }
    }
  }

  for (const event of reversals) {
    const minutes = (event.resolvedAt!.getTime() - event.occurredAt.getTime()) / 60000;
    if (minutes < MISSED_MIN_OPEN_MINUTES || minutes > MISSED_MAX_OPEN_MINUTES) continue;
    const current = health.get(event.symbol);
    const label = signalLabel(event.signalType).toLowerCase();
    const link = `/digest`;
    // A reversal on a company whose condition is currently met is about that
    // condition; anywhere else it is a missed event and says only that.
    const triggered = current?.health === "NEEDS_ATTENTION";
    out.push({
      symbol: event.symbol,
      type: triggered ? "TRIGGER_REVERSED" : "MISSED_EVENT",
      health: current?.health ?? null,
      reason: triggered
        ? `Your condition is met, and a detected event — ${label} — fired and reversed before you looked.`
        : `A detected event — ${label} — fired and reversed before you looked.`,
      link, sourceKind: "change_event", sourceId: event.id, occurredAt: event.occurredAt,
    });
  }
  return out;
}

/**
 * Writes anything new. Returns how many rows were actually created.
 *
 * `onConflictDoNothing` against the identity index is the whole de-duplication
 * story: running this twice over the same evidence writes nothing the second
 * time, and two concurrent runs cannot both win.
 */
export async function generateNotifications(userId: number): Promise<number> {
  return whenReady(() => generate(userId), 0);
}

async function generate(userId: number): Promise<number> {
  const preferences = await getPreferences(userId);
  if (!preferences.inApp) return 0;
  const rows = (await candidates(userId)).filter((candidate) => preferences[GATE[candidate.type]]);
  if (rows.length === 0) return 0;
  const dataMode = currentDataMode();
  const written = await db.insert(notifications)
    .values(rows.map((row) => ({
      userId, symbol: row.symbol, type: row.type, health: row.health, reason: row.reason,
      link: row.link, sourceKind: row.sourceKind, sourceId: row.sourceId,
      occurredAt: row.occurredAt, dataMode, channel: "IN_APP",
    })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.type, notifications.sourceKind, notifications.sourceId] })
    .returning({ id: notifications.id });
  return written.length;
}

/* ------------------------------------------------------------------- reads */

const LIST_LIMIT = 30;

export async function listNotifications(userId: number): Promise<NotificationRow[]> {
  return whenReady(() => list(userId), []);
}

async function list(userId: number): Promise<NotificationRow[]> {
  const rows = await db.select({
      id: notifications.id, symbol: notifications.symbol, type: notifications.type,
      health: notifications.health, reason: notifications.reason, link: notifications.link,
      occurredAt: notifications.occurredAt, readAt: notifications.readAt,
    })
    .from(notifications)
    // LIVE and DEMO REPLAY are separate worlds here too.
    .where(and(eq(notifications.userId, userId), eq(notifications.dataMode, currentDataMode())))
    .orderBy(desc(notifications.occurredAt)).limit(LIST_LIMIT);
  return rows.map((row) => ({ ...row, type: row.type as NotificationType, health: row.health as ThesisHealth | null }));
}

export async function markAllRead(userId: number): Promise<void> {
  await whenReady(() => db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), sql`${notifications.readAt} is null`)), undefined);
}

/** Scoped by user id in the predicate, so one account cannot read another's. */
export async function markRead(userId: number, id: number): Promise<void> {
  await whenReady(() => db.update(notifications).set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.id, id), sql`${notifications.readAt} is null`)), undefined);
}

/* ------------------------------------------------------------- preferences */

export async function getPreferences(userId: number): Promise<NotificationPreferences> {
  const [row] = await whenReady(() => db.select().from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId)).limit(1), []);
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    inApp: row.inApp, onTrigger: row.onTrigger, onNeedsAttention: row.onNeedsAttention,
    onWeakened: row.onWeakened, onInvalidated: row.onInvalidated, onReversal: row.onReversal,
  };
}

export async function savePreferences(userId: number, next: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
  const merged = { ...(await getPreferences(userId)), ...next };
  await whenReady(() => db.insert(notificationPreferences)
    .values({ userId, ...merged, updatedAt: new Date() })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { ...merged, updatedAt: new Date() } }), undefined);
  return merged;
}
