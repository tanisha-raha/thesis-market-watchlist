import "server-only";
import { cache } from "react";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { CONDITION_LABELS, evidenceFrom, getDigest, type Digest, type EvidenceEntry } from "@/lib/digest";
import { lastCommittedBatchAt } from "@/lib/ingestion";
import { formatExchangeTime, formatIST, IST } from "@/lib/time";
import { formatMoney, marketLine } from "@/lib/securities";
import { getWatchlist, type WatchlistRow } from "@/lib/watchlist";
import { getLatestAnomaly, type StoredAnomaly } from "@/lib/ml/anomaly-server";
import { anomalyEvidence } from "@/lib/ml/anomaly";
import { ADVICE_QUESTION, INVALIDATION, matchWatchedSymbol, type KnownSecurity } from "@/lib/ask-intent";
import { contradictionRule, type ThesisType } from "@/lib/thesis-engine";
import { symbols as symbolsTable } from "@/db/schema";

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

/**
 * A stored condition in words, or null when the shape carries no numbers.
 * One helper so the thesis answer and the reason-for-watching answer can never
 * describe the same saved condition differently.
 */
function conditionLine(thesis: AskThesis, currency: string | null): string | null {
  if (thesis.type === "price_range" && typeof thesis.params.low === "number" && typeof thesis.params.high === "number") {
    return `your recorded range is ${price(thesis.params.low, currency)} to ${price(thesis.params.high, currency)}`;
  }
  if (thesis.type === "breakout" && typeof thesis.params.level === "number") {
    return `your recorded level is ${price(thesis.params.level, currency)}`;
  }
  return null;
}

/** Every watched company the current digest has something recorded against. */
function changedSymbols(digest: Digest): { symbol: string; what: string }[] {
  const groups: [{ symbol: string }[], string][] = [
    [digest.contradictions, "thesis contradicted"],
    [digest.triggers, "condition triggered"],
    [digest.missed, "event that reversed while you were away"],
    [digest.anomalies, "unusual session recorded"],
  ];
  const found = new Map<string, string[]>();
  for (const [cards, label] of groups) {
    for (const card of cards) {
      if (!found.has(card.symbol)) found.set(card.symbol, []);
      const list = found.get(card.symbol)!;
      if (!list.includes(label)) list.push(label);
    }
  }
  return [...found].map(([symbol, labels]) => ({ symbol, what: labels.join(" and ") }));
}

/** Pure, bounded response selection. No price/event/thesis state is inferred here. */
export function answerFromContext(rawQuestion: string, context: AskContext, resolved?: { symbols: string[] }): AskReply {
  const question = rawQuestion.trim().slice(0, MAX_QUESTION_LENGTH);
  const prefix = modePrefix(context.mode);
  // Currency and clock come from the watched security itself, so an answer about
  // AAPL never quotes dollars in rupees or timestamps a NASDAQ event in IST.
  const rowFor = (symbol: string | null) => context.watchlist.find((row) => row.symbol === symbol);
  const zoneFor = (symbol: string | null) => rowFor(symbol)?.security.timeZone ?? IST;
  const currencyFor = (symbol: string | null) => rowFor(symbol)?.security.currency ?? null;
  const reply = (answer: string): AskReply => ({ mode: context.mode, answer: `${prefix}${answer}` });
  if (!question) return reply("Ask about a watched symbol, your thesis, or evidence THESIS has already detected.");

  if (ADVICE_QUESTION.test(question)) {
    return reply("I can explain what changed, how unusual a recorded move was, and how it relates to the condition you set, but I can’t recommend whether you should buy, sell, or hold.");
  }

  if (/\b(live|demo|replay)\b/i.test(question)) {
    const at = context.lastCompletedBatchAt ? `The latest completed ingestion batch committed at ${formatIST(context.lastCompletedBatchAt)} IST.` : "No completed ingestion batch is available yet.";
    return reply(at);
  }

  // The anomaly layer explains itself only from what was stored at detection
  // time, and only as an observation — never as a cause or a forecast.
  if (/\b(unusual|anomal\w*|pattern|outlier)\b/i.test(question)) {
    const target = resolved?.symbols?.[0] ?? matchWatchedSymbol(question, context.watchlist) ?? context.currentSymbol;
    const stored = target ? context.anomalies?.[target] : undefined;
    if (!target) {
      return reply("Name a watched company and I’ll tell you whether THESIS’s anomaly layer classified its most recent session as unusual, and show the signals it recorded.");
    }
    if (!stored) {
      return reply(`No stored anomaly evaluation is available for ${target}. The anomaly layer is secondary evidence and does not always have enough observed history; THESIS’s deterministic detection is unaffected.`);
    }
    const inputs = anomalyEvidence(stored.features).map((entry) => `${entry.label.toLowerCase()} ${entry.value}`).join(", ");
    return reply(stored.status === "UNUSUAL"
      ? `THESIS’s anomaly layer classified the combination of recorded market signals for ${target} on ${stored.tradingDate} as unusual relative to its own recent observations. At detection time: ${inputs}. Those are the inputs the model saw, not causes it identified, and this is secondary evidence — the deterministic engine decides what changed. It is not a prediction.`
      : `THESIS’s anomaly layer did not find the combination of signals recorded for ${target} on ${stored.tradingDate} unusual for this company. At detection time: ${inputs}.`);
  }

  if (/\b(sigma|σ|standard deviation)\b/i.test(question)) {
    return reply("A sigma (σ) expresses a recorded move relative to the symbol’s recent realized daily volatility. For example, 2.3σ means the move was 2.3 times that stored volatility measure; it is not a prediction.");
  }

  // A company NAMED in the question, kept separate from the page's current
  // symbol: "what changed" with a company in it is a question about that
  // company, while the same words on a company page are about the digest.
  // The conversation resolver may already have decided which company this turn
  // is about — including one carried over from an earlier message, which the
  // words in front of us do not mention at all.
  const named = resolved?.symbols?.[0] ?? matchWatchedSymbol(question, context.watchlist);
  const symbol = named ?? context.currentSymbol;
  // Any provider-style symbol with an exchange suffix — INFY.NS, TCS.BO — not
  // just NSE ones. Scoping is still watchlist membership, never the ticker.
  const requestedSymbol = /\b[A-Z][A-Z0-9-]*\.[A-Z]{1,3}\b/i.exec(question)?.[0]?.toUpperCase();
  if (requestedSymbol && !context.watchlist.some((row) => row.symbol === requestedSymbol)) {
    return reply(`${requestedSymbol} is not on your watchlist, so I do not have user-scoped THESIS context for it.`);
  }

  // WHY AM I WATCHING THIS. The honest answer is the user's own recorded reason,
  // read back to them — never a rationale THESIS composed on their behalf.
  if (/\bwhy\b/i.test(question) && /\b(watch|watching|watched|following|tracking|on my (watch)?list)\b/i.test(question)) {
    if (!symbol) return reply("Name one of your watched companies and I’ll read back the reason you recorded for it.");
    const row = rowFor(symbol);
    const thesis = context.theses.find((item) => item.symbol === symbol);
    const since = row ? ` You added it on ${formatExchangeTime(row.addedAt, row.security.timeZone)}.` : "";
    if (!thesis || thesis.type === "none") {
      return reply(`You are watching ${symbol}, but no structured condition and no note are recorded for it, so THESIS is only reporting detected market events for it.${since} Adding a condition is what lets it tell you when your own reason stops holding.`);
    }
    const condition = conditionLine(thesis, currencyFor(symbol));
    return reply(`You recorded “${thesisName(thesis.type)}” for ${symbol}${condition ? `, and ${condition}` : ""}.${thesis.note ? ` Your note at the time: “${thesis.note}”.` : " You did not add a note."} Its current deterministic state is ${thesis.state.toLowerCase().replace(/_/g, " ")}.${since}`);
  }

  // WHAT WOULD BREAK THIS. Answered from the engine's own contradiction rule,
  // not from prose written about it, so the explanation cannot drift from the
  // code that decides. Nothing is evaluated here; this states the standard.
  if (INVALIDATION.test(question) && !/\btriggered\b/i.test(question)) {
    if (!symbol) return reply("Name one of your watched companies and I’ll set out exactly what THESIS requires before it will call your condition contradicted.");
    const thesis = context.theses.find((item) => item.symbol === symbol);
    if (!thesis || thesis.type === "none") {
      return reply(`No structured condition is recorded for ${symbol}, so there is nothing for THESIS to contradict. A saved condition is what gives it something to test.`);
    }
    const rule = contradictionRule(thesis.type as ThesisType);
    if (rule.conditions.length === 0) {
      return reply(`“${thesisName(thesis.type)}” is a pure trigger condition: THESIS records when it is met and never marks it contradicted, so nothing invalidates it. Its current deterministic state is ${thesis.state.toLowerCase().replace(/_/g, " ")}.`);
    }
    const named = rule.conditions.map((name) => (CONDITION_LABELS[name] ?? name.replace(/_/g, " ")).toLowerCase());
    const hours = Math.round(rule.minimumObservationMs / 3600000);
    return reply(`Your “${thesisName(thesis.type)}” for ${symbol} is contradicted only when at least ${rule.required} of these ${rule.conditions.length} independent conditions hold on the same session — ${named.join("; ")} — and keep holding for ${rule.sustainedSessions} consecutive sessions. One condition on one day is not enough, and nothing can contradict it within ${hours} hours of when you wrote it or last acknowledged it. Its current deterministic state is ${thesis.state.toLowerCase().replace(/_/g, " ")}.`);
  }

  // WHICH OF MINE. A list across the watchlist, not one company.
  if (/\bwhich\b/i.test(question) && !named) {
    if (/\b(condition|conditions|thesis|theses|triggered|contradicted)\b/i.test(question)) {
      const active = context.theses.filter((t) => t.state === "TRIGGERED" || t.state === "CONTRADICTED");
      return reply(`${active.length ? active.map((t) => `${t.symbol}: ${t.state}`).join("; ") : "No saved conditions are currently marked triggered or contradicted."} ${digestSummary(context.digest)}`);
    }
    const changed = changedSymbols(context.digest);
    return reply(changed.length
      ? `${digestSummary(context.digest)} ${changed.map((entry) => `${entry.symbol} — ${entry.what}`).join("; ")}.`
      : `${digestSummary(context.digest)} No watched company has a recorded change in this digest window.`);
  }

  if (/\b(any|conditions|triggered)\b/i.test(question) && !symbol) {
    const active = context.theses.filter((t) => t.state === "TRIGGERED" || t.state === "CONTRADICTED");
    return reply(`${active.length ? active.map((t) => `${t.symbol}: ${t.state}`).join("; ") : "No saved conditions are currently marked triggered or contradicted."} ${digestSummary(context.digest)}`);
  }

  // THE SAVED CONDITION ITSELF. "Explain my Reliance thesis" is this question,
  // and it used to be excluded here for containing the word "explain".
  if (/\b(thesis|theses|condition|conditions)\b/i.test(question) && !/\b(triggered|contradicted)\b/i.test(question)) {
    const thesis = context.theses.find((item) => item.symbol === symbol);
    if (!symbol) return reply("Name a watched symbol and I’ll explain the structured thesis you recorded for it.");
    if (!thesis || thesis.type === "none") return reply(`No structured thesis is recorded for ${symbol}; THESIS can still surface general detected anomalies.`);
    const condition = conditionLine(thesis, currencyFor(symbol));
    const range = condition ? ` Your recorded range is ${condition.replace(/^your recorded (range|level) is /, "")}.` : "";
    return reply(`Your thesis for ${symbol} is “${thesisName(thesis.type)}” and its current deterministic state is ${thesis.state.toLowerCase().replace(/_/g, " ")}.${range}${thesis.note ? ` Your note: “${thesis.note}”` : ""}`);
  }

  if (/\b(significant|event|evidence|why)\b/i.test(question)) {
    if (/\b(triggered|contradicted)\b/i.test(question)) {
      const verdict = context.recentVerdicts?.find((item) => (!symbol || item.symbol === symbol) && question.toLowerCase().includes(item.signalType));
      return reply(verdict ? eventExplanation(verdict, zoneFor(verdict.symbol)) : `No matching stored thesis verdict is available${symbol ? ` for ${symbol}` : ""}. I won’t infer one from a market event.`);
    }
    const event = context.recentEvents.find((item) => !symbol || item.symbol === symbol);
    if (!event) return reply(symbol ? `THESIS has no stored detected event for ${symbol} to explain.` : "THESIS has no stored detected event in this scoped context to explain.");
    return reply(eventExplanation(event, zoneFor(event.symbol)));
  }

  if (/\b(changed|change|changes|miss|missed|meaningful|happened)\b/i.test(question)) {
    // Named company: answer for that company from its own stored records.
    if (named) {
      const parts: string[] = [];
      const verdict = context.recentVerdicts?.find((item) => item.symbol === named);
      const event = context.recentEvents.find((item) => item.symbol === named);
      if (verdict) parts.push(`Your thesis verdict: ${eventExplanation(verdict, zoneFor(named))}`);
      if (event) parts.push(eventExplanation(event, zoneFor(named)));
      const anomaly = context.anomalies?.[named];
      if (anomaly?.status === "UNUSUAL") parts.push(`The anomaly layer also classified the ${anomaly.tradingDate} session as unusual for this company — secondary evidence, not a cause.`);
      if (parts.length === 0) {
        const row = rowFor(named);
        const quote = row ? ` Its last stored price is ${price(row.price, row.security.currency)}${row.asOf ? ` as of ${formatExchangeTime(row.asOf, row.security.timeZone)}` : ""}.` : "";
        return reply(`THESIS has no detected event or thesis verdict recorded for ${named}.${quote}`);
      }
      return reply(parts.join(" "));
    }
    return reply(digestSummary(context.digest));
  }

  if (symbol) {
    const quote = rowFor(symbol);
    if (quote) {
      const freshness = quote.asOf ? ` as of ${formatExchangeTime(quote.asOf, quote.security.timeZone)}` : " with no quote timestamp yet";
      const market = marketLine(quote.security);
      return reply(`${symbol}${market ? ` (${market})` : ""} last traded at ${price(quote.price, quote.security.currency)}${freshness}. Ask about its thesis or a detected event for a more specific explanation.`);
    }
  }

  return reply("I can explain your digest, a watched symbol’s thesis, a detected event, or the meaning of stored evidence. I do not infer causes, predict prices, or provide investment advice.");
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

/**
 * Every security THESIS holds, for resolving a company someone names in chat.
 *
 * Shared market data, not user data: it is the same catalogue global search
 * already exposes to any authenticated user, and it decides only which name maps
 * to which symbol. What may then be SAID about that symbol is still decided by
 * the reader — personal surfaces stay behind watchlist membership.
 */
export const getAskCatalogue = cache(async function getAskCatalogue(): Promise<KnownSecurity[]> {
  const rows = await db.select({ symbol: symbolsTable.symbol, name: symbolsTable.name }).from(symbolsTable);
  return rows.filter((row) => !row.symbol.startsWith("^"));
});
