import "server-only";
import { answerFromContext, getAskCatalogue, getAskContext } from "@/lib/ask-thesis";
import { describeComparison, getComparison, thesisDataSection, unknownSecurities, type ComparisonMetricKey, type ComparisonRow } from "@/lib/ask-compare";
import { ADVICE_RESPONSE, allowGeneralRequest, generalExplanation } from "@/lib/finance-assistant";
import { conceptsById, explainConcepts, implementationOf } from "@/lib/finance-glossary";
import { resolveTurn, type KnownSecurity, type Turn } from "@/lib/ask-intent";
import { resolveNamedCompanies } from "@/lib/ask-entities-server";
import { getWatchlist } from "@/lib/watchlist";
import { getThesisReplay } from "@/lib/thesis-replay-server";

/**
 * One responder for the whole conversation.
 *
 * THE SHAPE OF THE THING. A general finance question gets a general finance
 * answer, whether or not it mentions a company — that is the correction this
 * file exists to make. Stored evidence then ENRICHES that answer in its own
 * labelled section; it does not replace it. Only a message that reaches for
 * something of the user's is answered from records alone.
 *
 * WHAT REACHES AN EXTERNAL MODEL. Grounded answers are composed here from
 * committed rows and never leave the server: no watchlist membership, saved
 * condition, note, quote, event, digest or anomaly is ever sent anywhere, and
 * turns carrying them are stripped from the history the model sees. What does go
 * is the general thread — the finance questions themselves, including the names
 * of companies the user typed, because that is the question.
 */

export type AskCategory = "THESIS DATA" | "COMPARISON" | "GENERAL" | "NON-ADVISORY";

export type AskResponse = {
  answer: string;
  category: AskCategory;
  mode?: "LIVE" | "DEMO REPLAY";
  /** The companies this answer was about, so the next turn can refer back to them. */
  symbols: string[];
  /** Where the general half came from. Never a failure state. */
  source?: "builtin" | "model" | "none";
  degraded?: boolean;
};

/**
 * Declining, and then being useful.
 *
 * The refusal is one sentence; the rest of the reply is the evaluation the user
 * actually needs, and the turn after it resolves into a comparison. A boundary
 * that ends the conversation is not a boundary anyone thanks you for.
 */
export const COMPARISON_INVITATION = "Tell me the companies you’re considering and I can go through them — what the businesses do, the fundamentals and valuation ideas worth checking, how volatile each has been, how each moves relative to its own market, and any evidence THESIS has recorded.";

const MAX_HISTORY_TURNS = 10;
const MAX_TURN_LENGTH = 800;

/** The client replays the conversation; none of it is trusted as given. */
export function boundedTurns(value: unknown): Turn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_HISTORY_TURNS).flatMap((item): Turn[] => {
    if (!item || (item.role !== "user" && item.role !== "assistant") || typeof item.text !== "string") return [];
    return [{
      role: item.role,
      text: item.text.slice(0, MAX_TURN_LENGTH),
      category: typeof item.category === "string" ? item.category.slice(0, 32) : null,
      symbols: Array.isArray(item.symbols)
        ? item.symbols.filter((s: unknown): s is string => typeof s === "string" && s.length <= 24).slice(0, 4)
        : undefined,
    }];
  });
}

/**
 * The conversation an external model may see.
 *
 * Every answer composed from the user's records is withheld — those are the
 * private half of this product. The general thread goes, because without it a
 * follow-up like "why does that matter?" has nothing to refer to.
 */
export function providerHistory(history: Turn[]): Turn[] {
  return history.filter((turn) => turn.category !== "THESIS DATA");
}

const REPLAY_QUESTION = /\b(happened before|historical|replay this|test .*thesis)\b/i;

/** Companies named in this turn, including any THESIS has never stored. */
async function companiesIn(message: string, turn: { symbols: string[]; carried: boolean }): Promise<string[]> {
  if (turn.carried) return turn.symbols;
  const named = await resolveNamedCompanies(message);
  return [...named, ...turn.symbols.filter((symbol) => !named.includes(symbol))].slice(0, 4);
}

/**
 * What can be said about companies with no model configured.
 *
 * Honest rather than empty: it names what cannot be verified, then gives the
 * framework that would answer the question, which is the part that does not
 * require knowing today's numbers.
 */
function companyFallback(symbols: string[], rows: ComparisonRow[]): string {
  const many = symbols.length >= 2;
  const framework = explainConcepts(conceptsById([many ? "comparing-stocks" : "evaluating-a-company"])) ?? "";
  const names = symbols.map((symbol) => rows.find((row) => row.symbol === symbol)?.name ?? symbol);
  const subject = names.length ? names.join(" and ") : "those companies";
  const verb = many ? "sell, earn or are worth" : "sells, earns or is worth";
  return `I can’t tell you what ${subject} ${verb} today — this deployment has no open-ended finance model configured, and THESIS stores market observations rather than company fundamentals, so anything specific about the business would be me guessing at it. What I can give you is the shape of the question. ${framework}`;
}

export async function respond(input: {
  userId: number;
  message: string;
  history: Turn[];
  currentSymbol?: string | null;
  mode?: string | null;
}): Promise<AskResponse> {
  const { userId, message, history } = input;
  // The catalogue resolves a company someone names; watchlist membership decides
  // what may then be said about it. Both are cheap, memoised reads.
  const [watchlist, catalogue] = await Promise.all([getWatchlist(userId), getAskCatalogue()]);
  const known: KnownSecurity[] = [...watchlist.map((row) => ({ symbol: row.symbol, name: row.name })), ...catalogue];
  const turn = resolveTurn(message, history, known, input.mode);

  /* ------------------------------------------------------------- advisory */
  if (turn.resolved === "ADVISORY") {
    const symbols = await companiesIn(message, turn);
    const rows = symbols.length ? await getComparison(userId, symbols) : [];
    const framework = explainConcepts(conceptsById([symbols.length >= 2 ? "comparing-stocks" : "evaluating-a-company"]));
    const stored = thesisDataSection(rows);
    return {
      answer: [ADVICE_RESPONSE, framework, stored, symbols.length ? null : COMPARISON_INVITATION]
        .filter(Boolean).join("\n\n"),
      category: "NON-ADVISORY",
      symbols,
    };
  }

  /* -------------------------------------------------------------- general */
  if (turn.resolved === "GENERAL") {
    // A follow-up about how THESIS implements a concept it just explained.
    if (turn.implementation) {
      const answer = implementationOf(conceptsById(turn.concepts));
      if (answer) return { answer, category: "GENERAL", symbols: [], source: "builtin" };
    }

    const symbols = await companiesIn(message, turn);
    const rows: ComparisonRow[] = symbols.length ? await getComparison(userId, symbols) : [];

    // "Which one is more volatile?" — a stored measurement across the companies
    // the conversation is already about. Answered from rows, never estimated.
    if (turn.metric && symbols.length >= 2) {
      const missing = await unknownSecurities(symbols.filter((symbol) => !rows.some((row) => row.symbol === symbol)));
      return {
        answer: describeComparison(rows, { metric: turn.metric as ComparisonMetricKey, unknown: missing }),
        category: "COMPARISON", symbols,
      };
    }

    const general = await generalExplanation(message, providerHistory(history), {
      allowProvider: () => allowGeneralRequest(userId),
    });
    // Nothing prepared and no model. Rather than shrug: if companies were named,
    // say what cannot be verified and give the framework; if the turn was
    // following on from a concept, stay on that concept.
    let body = general.answer;
    if (general.source === "none") {
      // A follow-up with no company: stay on the concept the conversation was
      // already about rather than answering as if it had never been mentioned.
      const [concept] = turn.carried ? conceptsById(turn.concepts) : [];
      if (symbols.length) body = companyFallback(symbols, rows);
      else if (concept) body = `Still on ${concept.term.toLowerCase()}. ${concept.explanation}${concept.inThesis ? ` In THESIS, ${concept.inThesis}` : ""}`;
    }
    const stored = thesisDataSection(rows);
    return {
      answer: stored ? `${body}\n\n${stored}` : body,
      category: symbols.length >= 2 ? "COMPARISON" : "GENERAL",
      symbols,
      source: general.source,
      degraded: general.degraded,
    };
  }

  /* ------------------------------------------------------------- grounded */
  const context = await getAskContext(userId, input.currentSymbol ?? null);

  if (REPLAY_QUESTION.test(message) && context.currentSymbol) {
    const replay = await getThesisReplay(userId, context.currentSymbol);
    return {
      category: "THESIS DATA", mode: context.mode, symbols: [context.currentSymbol],
      answer: replay?.status === "ready"
        ? `THESIS Replay for ${context.currentSymbol}: ${replay.occurrences.length} observed daily-close occurrences across ${replay.sessions} sessions (${replay.from} to ${replay.through}); ${replay.resolved} resolved at a later close. ${replay.message} Historical analysis, not a prediction.`
        : replay?.message ?? "No user-scoped replay is available.",
    };
  }

  // Explicitly asking for recorded evidence across several companies.
  const grounded = await companiesIn(message, turn);
  if (grounded.length >= 2) {
    const rows = await getComparison(userId, grounded);
    const missing = await unknownSecurities(grounded.filter((symbol) => !rows.some((row) => row.symbol === symbol)));
    return {
      answer: describeComparison(rows, { metric: turn.metric as ComparisonMetricKey | null, unknown: missing }),
      category: "COMPARISON", symbols: grounded,
    };
  }

  // A company THESIS follows but this user does not watch. Nothing personal
  // exists for it, so the answer is its market evidence and says as much.
  const target = grounded[0];
  if (target && !watchlist.some((row) => row.symbol === target)) {
    const rows = await getComparison(userId, [target]);
    if (rows.length) {
      return {
        category: "COMPARISON", symbols: [target],
        answer: `You don’t watch ${target}, so THESIS has recorded no condition, note or verdict of yours for it. ${describeComparison(rows)}`,
      };
    }
  }

  const reply = answerFromContext(message, context, { symbols: grounded });
  return { answer: reply.answer, category: "THESIS DATA", mode: reply.mode, symbols: grounded.slice(0, 1) };
}
