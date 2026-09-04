import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, theses, watchlistItems } from "@/db/schema";
import { evidenceFrom, getDigest, type Digest, type EvidenceEntry } from "@/lib/digest";
import { lastCommittedBatchAt } from "@/lib/ingestion";
import { formatIST } from "@/lib/time";
import { getWatchlist, type WatchlistRow } from "@/lib/watchlist";

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
  lastCompletedBatchAt: Date | null;
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

const inr = (value: number | null) => value == null
  ? "no last-known price"
  : `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;

function modePrefix(mode: AskDataMode) {
  return mode === "DEMO REPLAY"
    ? "This answer is based on DEMO REPLAY data. "
    : "This answer is based on THESIS’s stored LIVE data. ";
}

function symbolInQuestion(question: string, context: AskContext): string | null {
  const upper = question.toUpperCase();
  const exact = context.watchlist.find((row) => upper.includes(row.symbol.toUpperCase()));
  if (exact) return exact.symbol;
  // People naturally say “INFY”, while the provider identity is “INFY.NS”.
  // Resolve that shorthand only against the already-scoped watchlist, never a
  // global symbol universe, so it cannot widen what this user can ask about.
  const shorthand = context.watchlist.find((row) => {
    const root = row.symbol.replace(/\.NS$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function eventExplanation(event: AskEvent): string {
  const evidence = event.evidence.length
    ? ` Stored evidence: ${event.evidence.map((entry) => `${entry.label} ${entry.value}${entry.basis ? ` (${entry.basis})` : ""}`).join("; ")}.`
    : " THESIS did not record additional quantitative evidence for this event.";
  const status = event.resolvedAt
    ? ` It resolved at ${formatIST(event.resolvedAt)} IST.`
    : " It is still recorded as open.";
  return `${event.symbol} was marked for ${event.signalType.replace(/_/g, " ")} at ${formatIST(event.occurredAt)} IST.${status}${evidence}`;
}

/** Pure, bounded response selection. No price/event/thesis state is inferred here. */
export function answerFromContext(rawQuestion: string, context: AskContext): AskReply {
  const question = rawQuestion.trim().slice(0, MAX_QUESTION_LENGTH);
  const prefix = modePrefix(context.mode);
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

  if (/\b(sigma|σ|standard deviation)\b/i.test(question)) {
    return {
      mode: context.mode,
      answer: `${prefix}A sigma (σ) expresses a recorded move relative to the symbol’s recent realized daily volatility. For example, 2.3σ means the move was 2.3 times that stored volatility measure; it is not a prediction.`,
    };
  }

  const symbol = symbolInQuestion(question, context);
  const requestedSymbol = /\b[A-Z][A-Z0-9-]*\.NS\b/i.exec(question)?.[0]?.toUpperCase();
  if (requestedSymbol && !context.watchlist.some((row) => row.symbol === requestedSymbol)) {
    return { mode: context.mode, answer: `${prefix}${requestedSymbol} is not on your watchlist, so I do not have user-scoped THESIS context for it.` };
  }

  if (/\b(thesis|condition|did .*hit)\b/i.test(question)) {
    const thesis = context.theses.find((item) => item.symbol === symbol);
    if (!symbol) return { mode: context.mode, answer: `${prefix}Name a watched symbol and I’ll explain the structured thesis you recorded for it.` };
    if (!thesis || thesis.type === "none") return { mode: context.mode, answer: `${prefix}No structured thesis is recorded for ${symbol}; THESIS can still surface general detected anomalies.` };
    const range = thesis.type === "price_range" && typeof thesis.params.low === "number" && typeof thesis.params.high === "number"
      ? ` Your recorded range is ${inr(thesis.params.low)} to ${inr(thesis.params.high)}.`
      : "";
    return { mode: context.mode, answer: `${prefix}Your thesis for ${symbol} is “${thesisName(thesis.type)}” and its current deterministic state is ${thesis.state.toLowerCase().replace(/_/g, " ")}.${range}${thesis.note ? ` Your note: “${thesis.note}”` : ""}` };
  }

  if (/\b(significant|event|why)\b/i.test(question)) {
    const event = context.recentEvents.find((item) => !symbol || item.symbol === symbol);
    if (!event) return { mode: context.mode, answer: `${prefix}${symbol ? `THESIS has no stored detected event for ${symbol} to explain.` : "THESIS has no stored detected event in this scoped context to explain."}` };
    return { mode: context.mode, answer: `${prefix}${eventExplanation(event)}` };
  }

  if (/\b(changed|miss|meaningful)\b/i.test(question)) {
    return { mode: context.mode, answer: `${prefix}${digestSummary(context.digest)}` };
  }

  if (symbol) {
    const quote = context.watchlist.find((row) => row.symbol === symbol);
    if (quote) {
      const freshness = quote.asOf ? ` as of ${formatIST(quote.asOf)} IST` : " with no quote timestamp yet";
      return { mode: context.mode, answer: `${prefix}${symbol}’s last-known quote is ${inr(quote.price)}${freshness}. Ask about its thesis or a detected event for a more specific explanation.` };
    }
  }

  return { mode: context.mode, answer: `${prefix}I can explain your digest, a watched symbol’s thesis, a detected event, or the meaning of stored evidence. I do not infer causes, predict prices, or provide investment advice.` };
}

/** Read-only, per-user context assembly. Every database predicate starts at watchlist membership. */
export async function getAskContext(userId: number, currentSymbol?: string | null): Promise<AskContext> {
  const watchlist = await getWatchlist(userId);
  const symbolList = watchlist.map((row) => row.symbol);
  const [digest, lastCompletedBatchAt, thesisRows, eventRows] = await Promise.all([
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
  ]);

  return {
    // Demo replay is opt-in, so stored/seeded history cannot accidentally be presented as replay.
    mode: process.env.THESIS_DATA_MODE === "demo" ? "DEMO REPLAY" : "LIVE",
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
  };
}
