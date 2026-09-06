import "server-only";
import { answerFromContext, getAskCatalogue, getAskContext } from "@/lib/ask-thesis";
import { describeComparison, getComparison, unknownSecurities, type ComparisonMetricKey } from "@/lib/ask-compare";
import { ADVICE_RESPONSE, allowGeneralRequest, generalExplanation } from "@/lib/finance-assistant";
import { conceptsById, explainConcepts, implementationOf } from "@/lib/finance-glossary";
import { resolveSymbols, resolveTurn, type KnownSecurity, type Turn } from "@/lib/ask-intent";
import { resolveNamedCompanies } from "@/lib/ask-entities-server";
import { getWatchlist } from "@/lib/watchlist";
import { getThesisReplay } from "@/lib/thesis-replay-server";

/**
 * One responder for the whole conversation.
 *
 * Everything a turn needs is assembled here — the recent messages, the resolved
 * intent, the companies and concepts the turn is about, and only then the user's
 * stored context — so that the route is transport and this is the behaviour.
 *
 * WHAT REACHES AN EXTERNAL MODEL. Grounded answers and comparisons are composed
 * here from committed rows and never leave the server; no watchlist, condition,
 * note, quote, event or anomaly is sent anywhere. The optional model is used for
 * general finance education only, and only for concepts the built-in table does
 * not hold — a question about the meaning of a word, with no user data attached.
 */

export type AskCategory = "THESIS DATA" | "COMPARISON" | "GENERAL" | "NON-ADVISORY";

export type AskResponse = {
  answer: string;
  category: AskCategory;
  mode?: "LIVE" | "DEMO REPLAY";
  /** The companies this answer was about, so the next turn can refer back to them. */
  symbols: string[];
  /** Where a general explanation came from. Never a failure state. */
  source?: "builtin" | "model" | "none";
  degraded?: boolean;
};

/**
 * Declining, and then being useful.
 *
 * The refusal is not the end of the exchange: it names what THESIS can do
 * instead and asks the question whose answer routes the next turn into a
 * grounded comparison.
 */
export const COMPARISON_INVITATION = "I can compare companies using the market evidence THESIS has recorded — price and freshness, recent movement, volatility, how each moved relative to its own market index, any detected events, and the anomaly layer's classification. Which companies are you considering?";

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
 * The only conversation an external model may see.
 *
 * Grounded answers and comparisons are dropped, and so is any earlier message
 * that named a company — a list of what someone is weighing up is theirs. What
 * remains is the general-education thread: definitions, and the questions that
 * asked for them.
 */
export function providerHistory(history: Turn[], known: KnownSecurity[]): Turn[] {
  return history.filter((turn) => turn.role === "assistant"
    ? turn.category === "GENERAL"
    : resolveSymbols(turn.text, known).length === 0);
}

/** Did the assistant just decline advice, or just compare? Then names are companies. */
function comparisonWasInvited(history: Turn[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    return history[i].category === "NON-ADVISORY" || history[i].category === "COMPARISON";
  }
  return false;
}

const REPLAY_QUESTION = /\b(happened before|historical|replay this|test .*thesis)\b/i;

export async function respond(input: {
  userId: number;
  message: string;
  history: Turn[];
  currentSymbol?: string | null;
  mode?: string | null;
}): Promise<AskResponse> {
  const { userId, message, history } = input;
  // The catalogue resolves a company someone names; the watchlist decides what
  // may then be said about it. Both are cheap, memoised reads.
  const [watchlist, catalogue] = await Promise.all([getWatchlist(userId), getAskCatalogue()]);
  const known = [...watchlist.map((row) => ({ symbol: row.symbol, name: row.name })), ...catalogue];
  const turn = resolveTurn(message, history, known, input.mode);

  // A comparison may name a company THESIS does not hold yet. Resolving it is
  // what lets the answer say "nothing is recorded for AAPL" instead of quietly
  // dropping half the question.
  const comparing = turn.intent === "COMPARISON" || turn.asksComparison || comparisonWasInvited(history);
  if (comparing && !turn.carried) {
    const named = await resolveNamedCompanies(message);
    const merged = [...named, ...turn.symbols.filter((symbol) => !named.includes(symbol))].slice(0, 4);
    if (merged.length) {
      turn.symbols = merged;
      if (merged.length >= 2) turn.intent = "COMPARISON";
    }
  }

  if (turn.intent === "ADVISORY") {
    return { answer: `${ADVICE_RESPONSE} ${COMPARISON_INVITATION}`, category: "NON-ADVISORY", symbols: turn.symbols };
  }

  if (turn.intent === "COMPARISON") {
    const rows = await getComparison(userId, turn.symbols);
    const missing = await unknownSecurities(turn.symbols.filter((symbol) => !rows.some((row) => row.symbol === symbol)));
    return {
      answer: describeComparison(rows, { metric: turn.metric as ComparisonMetricKey | null, unknown: missing }),
      category: "COMPARISON",
      // Every company that was ASKED about, so a follow-up keeps both even when
      // one of them turned out to be unknown.
      symbols: turn.symbols,
    };
  }

  if (turn.intent === "GENERAL") {
    // A follow-up about how THESIS implements a concept it just explained.
    if (turn.implementation) {
      const answer = implementationOf(conceptsById(turn.concepts));
      if (answer) return { answer, category: "GENERAL", symbols: [], source: "builtin" };
    }
    // A follow-up that referred back to a concept without naming it again.
    if (turn.concepts.length && !turn.carried) {
      const carried = explainConcepts(conceptsById(turn.concepts));
      if (carried) return { answer: carried, category: "GENERAL", symbols: [], source: "builtin" };
    }
    const general = await generalExplanation(message, providerHistory(history, known), {
      allowProvider: () => allowGeneralRequest(userId),
    });
    return { answer: general.answer, category: "GENERAL", symbols: [], source: general.source, degraded: general.degraded };
  }

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

  // A company THESIS follows but this user does not watch. Nothing personal
  // exists for it, so the answer is its market evidence and says as much.
  const target = turn.symbols[0];
  if (target && !watchlist.some((row) => row.symbol === target)) {
    const rows = await getComparison(userId, [target]);
    if (rows.length) {
      return {
        category: "COMPARISON", symbols: [target],
        answer: `You don’t watch ${target}, so THESIS has recorded no condition, note or verdict of yours for it. ${describeComparison(rows)}`,
      };
    }
  }

  const reply = answerFromContext(message, context, { symbols: turn.symbols });
  return { answer: reply.answer, category: "THESIS DATA", mode: reply.mode, symbols: turn.symbols.slice(0, 1) };
}
