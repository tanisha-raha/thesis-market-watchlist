import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { evidenceFrom, getDigest, type Digest, type EvidenceEntry } from "@/lib/digest";
import { lastCommittedBatchAt } from "@/lib/ingestion";
import { formatExchangeTime, formatIST, IST } from "@/lib/time";
import { formatMoney, marketLine } from "@/lib/securities";
import { getWatchlist, type WatchlistRow } from "@/lib/watchlist";
import { getLatestAnomaly, type StoredAnomaly } from "@/lib/ml/anomaly-server";
import { anomalyEvidence } from "@/lib/ml/anomaly";

/**
 * Ask THESIS is deliberately a reader of committed product state. It has no
 * write path and never invokes detection or thesis evaluation. Keeping its
 * context bounded and typed makes that boundary inspectable.
 */
export type AskDataMode = "LIVE" | "DEMO REPLAY";

export type AskThesis = {
  symbol: string;
  type: string;
  state: string;
  note: string | null;
  params: Record<string, unknown>;
};

export type AskEvent = {
  symbol: string;
  signalType: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  evidence: EvidenceEntry[];
};

export type AskContext = {
  mode: AskDataMode;
  currentSymbol: string | null;
  watchlist: WatchlistRow[];
  theses: AskThesis[];
  digest: Digest;
  recentEvents: AskEvent[];
  recentVerdicts?: AskEvent[];
  lastCompletedBatchAt: Date | null;
  /** Stored anomaly evaluations for watched symbols. Secondary evidence, optional. */
  anomalies?: Record<string, StoredAnomaly>;
};

export type AskReply = {
  answer: string;
  mode: AskDataMode;
  /** A provider outage never leaks into the core product; this only annotates the drawer. */
  degraded?: boolean;
};

const MAX_QUESTION_LENGTH = 800;
const ADVISORY = /\b(should i|should we|buy|sell|hold|good investment|what stock .*buy|will .*go up|will .*go down|price target|recommend)\b/i;

const thesisName = (type: string) => ({
  price_range: "Waiting for a dip",
  breakout: "Watching for a breakout",
  momentum_up: "Tracking momentum",
  momentum_down: "Tracking a decline",
  volatility_watch: "Watching for unusual moves",
  volume_expansion: "Watching for volume expansion",
}[type] ?? type.replace(/_/g, " "));

/** Money in the security's own currency; the watchlist row is the source of it. */
const price = (value: number | null, currency: string | null) => value == null
  ? "no last-known price"
  : formatMoney(value, currency);

function modePrefix(mode: AskDataMode) {
  return mode === "DEMO REPLAY"
    ? "This answer is based on DEMO REPLAY data. "
    : "This answer is based on THESIS’s stored market data, which may be delayed or stale. ";
}

function symbolInQuestion(question: string, context: AskContext): string | null {
  const upper = question.toUpperCase();
  const exact = context.watchlist.find((row) => upper.includes(row.symbol.toUpperCase()));
  if (exact) return exact.symbol;
  // People naturally say “INFY” for INFY.NS. Resolve that shorthand only against
  // the already-scoped watchlist, never a global symbol universe, so it cannot
  // widen what this user can ask about.
  const shorthand = context.watchlist.find((row) => {
    const root = row.symbol.replace(/\.[A-Z]{1,3}$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${root}\\b`, "i").test(question);
  });
  if (shorthand) return shorthand.symbol;
  const named = context.watchlist.find((row) => row.name && upper.includes(row.name.toUpperCase()));
  return named?.symbol ?? context.currentSymbol;
}

function digestSummary(digest: Digest): string {
  const parts = [
    [digest.contradictions.length, "contradicted thesis"],
    [digest.triggers.length, "condition triggered"],
    [digest.missed.length, "event that reversed while you were away"],
    [digest.anomalies.length, "general anomaly"],
  ].filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}${Number(count) === 1 ? "" : "s"}`);
  if (parts.length === 0) return "THESIS has no new detected changes in your current digest window.";
  return `THESIS found ${parts.join(", ")}.`;
}

function eventExplanation(event: AskEvent, timeZone: string): string {
  const evidence = event.evidence.length
    ? ` Stored evidence: ${event.evidence.map((entry) => `${entry.label} ${entry.value}${entry.basis ? ` (${entry.basis})` : ""}`).join("; ")}.`
    : " THESIS did not record additional quantitative evidence for this event.";
  const status = event.resolvedAt
    ? ` It resolved at ${formatExchangeTime(event.resolvedAt, timeZone)}.`
    : " It is still recorded as open.";
  return `${event.symbol} was marked for ${event.signalType.replace(/_/g, " ")} at ${formatExchangeTime(event.occurredAt, timeZone)}.${status}${evidence}`;
}

/** Pure, bounded response selection. No price/event/thesis state is inferred here. */
export function answerFromContext(rawQuestion: string, context: AskContext): AskReply {
  const question = rawQuestion.trim().slice(0, MAX_QUESTION_LENGTH);
  const prefix = modePrefix(context.mode);
  // Currency and clock come from the watched security itself, so an answer about
  // AAPL never quotes dollars in rupees or timestamps a NASDAQ event in IST.
  const rowFor = (symbol: string | null) => context.watchlist.find((row) => row.symbol === symbol);
  const zoneFor = (symbol: string | null) => rowFor(symbol)?.security.timeZone ?? IST;
  const currencyFor = (symbol: string | null) => rowFor(symbol)?.security.currency ?? null;
  if (!question) return { mode: context.mode, answer: `${prefix}Ask about a watched symbol, your thesis, or evidence THESIS has already detected.` };

  if (ADVISORY.test(question)) {
    return {
      mode: context.mode,
      answer: `${prefix}I can explain what changed, how unusual a recorded move was, and how it relates to the condition you set, but I can’t recommend whether you should buy, sell, or hold.`,
    };
  }

  if (/\b(live|demo|replay)\b/i.test(question)) {
    const at = context.lastCompletedBatchAt ? ` The latest completed ingestion batch committed at ${formatIST(context.lastCompletedBatchAt)} IST.` : " No completed ingestion batch is available yet.";
    return { mode: context.mode, answer: `${prefix}${at.trimStart()}` };
  }

  // The anomaly layer explains itself only from what was stored at detection
  // time, and only as an observation — never as a cause or a forecast.
  if (/\b(unusual|anomal\w*|pattern|outlier)\b/i.test(question)) {
    const target = symbolInQuestion(question, context);
    const stored = target ? context.anomalies?.[target] : undefined;
    if (!target) {
      return { mode: context.mode, answer: `${prefix}Name a watched company and I’ll tell you whether THESIS’s anomaly layer classified its most recent session as unusual, and show the signals it recorded.` };
    }
    if (!stored) {
      return { mode: context.mode, answer: `${prefix}No stored anomaly evaluation is available for ${target}. The anomaly layer is secondary evidence and does not always have enough observed history; THESIS’s deterministic detection is unaffected.` };
    }
    const inputs = anomalyEvidence(stored.features).map((entry) => `${entry.label.toLowerCase()} ${entry.value}`).join(", ");
    return {
      mode: context.mode,
      answer: stored.status === "UNUSUAL"
        ? `${prefix}THESIS’s anomaly layer classified the combination of recorded market signals for ${target} on ${stored.tradingDate} as unusual relative to its own recent observations. At detection time: ${inputs}. Those are the inputs the model saw, not causes it identified, and this is secondary evidence — the deterministic engine decides what changed. It is not a prediction.`
        : `${prefix}THESIS’s anomaly layer did not find the combination of signals recorded for ${target} on ${stored.tradingDate} unusual for this company. At detection time: ${inputs}.`,
    };
  }

  if (/\b(sigma|σ|standard deviation)\b/i.test(question)) {
    return {
      mode: context.mode,
      answer: `${prefix}A sigma (σ) expresses a recorded move relative to the symbol’s recent realized daily volatility. For example, 2.3σ means the move was 2.3 times that stored volatility measure; it is not a prediction.`,
    };
  }

  const symbol = symbolInQuestion(question, context);
  // Any provider-style symbol with an exchange suffix — INFY.NS, TCS.BO — not
  // just NSE ones. Scoping is still watchlist membership, never the ticker.
  const requestedSymbol = /\b[A-Z][A-Z0-9-]*\.[A-Z]{1,3}\b/i.exec(question)?.[0]?.toUpperCase();
  if (requestedSymbol && !context.watchlist.some((row) => row.symbol === requestedSymbol)) {
    return { mode: context.mode, answer: `${prefix}${requestedSymbol} is not on your watchlist, so I do not have user-scoped THESIS context for it.` };
  }

  if (/\b(any|conditions|triggered)\b/i.test(question) && !symbol) {
    const active = context.theses.filter((t) => t.state === "TRIGGERED" || t.state === "CONTRADICTED");
    return { mode: context.mode, answer: `${prefix}${active.length ? active.map((t) => `${t.symbol}: ${t.state}`).join("; ") : "No saved conditions are currently marked triggered or contradicted."} ${digestSummary(context.digest)}` };
  }
  if (!/\b(why|explain)\b/i.test(question) && /\b(thesis|condition|did .*hit)\b/i.test(question)) {
    const thesis = context.theses.find((item) => item.symbol === symbol);
    if (!symbol) return { mode: context.mode, answer: `${prefix}Name a watched symbol and I’ll explain the structured thesis you recorded for it.` };
    if (!thesis || thesis.type === "none") return { mode: context.mode, answer: `${prefix}No structured thesis is recorded for ${symbol}; THESIS can still surface general detected anomalies.` };
    const range = thesis.type === "price_range" && typeof thesis.params.low === "number" && typeof thesis.params.high === "number"
      ? ` Your recorded range is ${price(thesis.params.low, currencyFor(symbol))} to ${price(thesis.params.high, currencyFor(symbol))}.`
      : "";
    return { mode: context.mode, answer: `${prefix}Your thesis for ${symbol} is “${thesisName(thesis.type)}” and its current deterministic state is ${thesis.state.toLowerCase().replace(/_/g, " ")}.${range}${thesis.note ? ` Your note: “${thesis.note}”` : ""}` };
  }

  if (/\b(significant|event|evidence|why)\b/i.test(question)) {
    if (/\b(triggered|contradicted)\b/i.test(question)) {
      const verdict = context.recentVerdicts?.find((item) => (!symbol || item.symbol === symbol) && question.toLowerCase().includes(item.signalType));
      return { mode: context.mode, answer: `${prefix}${verdict ? eventExplanation(verdict, zoneFor(verdict.symbol)) : `No matching stored thesis verdict is available${symbol ? ` for ${symbol}` : ""}. I won’t infer one from a market event.`}` };
    }
    const event = context.recentEvents.find((item) => !symbol || item.symbol === symbol);
    if (!event) return { mode: context.mode, answer: `${prefix}${symbol ? `THESIS has no stored detected event for ${symbol} to explain.` : "THESIS has no stored detected event in this scoped context to explain."}` };
    return { mode: context.mode, answer: `${prefix}${eventExplanation(event, zoneFor(event.symbol))}` };
  }

  if (/\b(changed|miss|meaningful)\b/i.test(question)) {
    return { mode: context.mode, answer: `${prefix}${digestSummary(context.digest)}` };
  }

  if (symbol) {
    const quote = rowFor(symbol);
    if (quote) {
      const freshness = quote.asOf ? ` as of ${formatExchangeTime(quote.asOf, quote.security.timeZone)}` : " with no quote timestamp yet";
      const market = marketLine(quote.security);
      return { mode: context.mode, answer: `${prefix}${symbol}${market ? ` (${market})` : ""} last traded at ${price(quote.price, quote.security.currency)}${freshness}. Ask about its thesis or a detected event for a more specific explanation.` };
    }
  }

  return { mode: context.mode, answer: `${prefix}I can explain your digest, a watched symbol’s thesis, a detected event, or the meaning of stored evidence. I do not infer causes, predict prices, or provide investment advice.` };
}

/** Read-only, per-user context assembly. Every database predicate starts at watchlist membership. */
export async function getAskContext(userId: number, currentSymbol?: string | null): Promise<AskContext> {
  const watchlist = await getWatchlist(userId);
  const symbolList = watchlist.map((row) => row.symbol);
  const [digest, lastCompletedBatchAt, thesisRows, eventRows, verdictRows] = await Promise.all([
    getDigest(userId),
    lastCommittedBatchAt(),
    db.select({ symbol: watchlistItems.symbol, type: theses.type, state: theses.state, note: theses.note, params: theses.paramsJson })
      .from(watchlistItems)
      .leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
      .where(eq(watchlistItems.userId, userId)),
    symbolList.length === 0
      ? Promise.resolve([])
      : db.select({ symbol: changeEvents.symbol, signalType: changeEvents.signalType, occurredAt: changeEvents.occurredAt, resolvedAt: changeEvents.resolvedAt, explain: changeEvents.explainJson })
        .from(changeEvents).where(inArray(changeEvents.symbol, symbolList)).orderBy(desc(changeEvents.occurredAt)).limit(8),
    db.select({ symbol: watchlistItems.symbol, kind: thesisEvents.kind, at: thesisEvents.occurredAt, resolvedAt: thesisEvents.resolvedAt, evidence: thesisEvents.evidenceJson }).from(watchlistItems)
      .innerJoin(theses, eq(theses.watchlistItemId, watchlistItems.id)).innerJoin(thesisEvents, eq(thesisEvents.thesisId, theses.id))
      .where(eq(watchlistItems.userId, userId)).orderBy(desc(thesisEvents.occurredAt)).limit(8),
  ]);

  // Optional and isolated: a failure here costs an explanation, never an answer.
  const anomalies: Record<string, StoredAnomaly> = {};
  for (const symbol of symbolList) {
    const stored = await getLatestAnomaly(symbol).catch(() => null);
    if (stored) anomalies[symbol] = stored;
  }

  return {
    // Demo replay is opt-in, so stored/seeded history cannot accidentally be presented as replay.
    mode: process.env.THESIS_DATA_MODE === "demo" ? "DEMO REPLAY" : "LIVE",
    anomalies,
    currentSymbol: currentSymbol && symbolList.includes(currentSymbol) ? currentSymbol : null,
    watchlist,
    theses: thesisRows.flatMap((row) => row.type ? [{
      symbol: row.symbol, type: row.type, state: row.state ?? "WATCHING", note: row.note,
      params: (row.params ?? {}) as Record<string, unknown>,
    }] : []),
    digest,
    recentEvents: eventRows.map((row) => ({
      symbol: row.symbol, signalType: row.signalType, occurredAt: row.occurredAt, resolvedAt: row.resolvedAt,
      evidence: evidenceFrom(row.explain as Record<string, unknown>),
    })),
    lastCompletedBatchAt,
    recentVerdicts: verdictRows.map((v) => ({ symbol: v.symbol, signalType: v.kind, occurredAt: v.at, resolvedAt: v.resolvedAt, evidence: evidenceFrom(v.evidence as Record<string, unknown>) })),
  };
}
