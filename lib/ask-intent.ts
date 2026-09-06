/**
 * What kind of question was that?
 *
 * Ask THESIS answers three different kinds of question and must never confuse
 * them: one about the user's own recorded data, one about a finance concept, and
 * one asking to be told what to do with money. Routing used to be a single
 * keyword regex that knew nothing about the user, which is why "Why am I
 * watching SBILIFE?" — a question with no vocabulary from that list, about a
 * company sitting on the asker's own watchlist — was sent to the general
 * explainer and came back as a not-connected message.
 *
 * So the classifier is given the watchlist. A question that names a company the
 * user actually watches is a question about their data, whatever words surround
 * it. Nothing here reads a database or reaches a network; it is a decision about
 * a sentence, and it is pure so it can be tested against every prompt directly.
 */

export type AskIntent = "ADVISORY" | "GROUNDED" | "GENERAL";

/** The minimum a caller must know about a watched row to classify against it. */
export type WatchedSecurity = { symbol: string; name?: string | null };

/**
 * Asking to be told what to do. Checked first and never overridden, including
 * when the user has explicitly selected a conversation mode: a mode selector is
 * not consent to receive investment advice.
 */
export const ADVICE_QUESTION = /\b(should (?:i|we)|buy|sell|hold|invest in|investment recommend|good investment|price target|recommend|predict|will .*go (?:up|down)|which stock)\b/i;

/** First-person or product-record words. These are never a definition request. */
const OWNERSHIP = /\b(my|mine|our|ours|watchlist|watching|watched|thesis|theses|triggered?|contradicted|missed?|digest|away|since i|replay|verdict|verdicts|holding|holdings|position|positions|portfolio)\b/i;

/**
 * Product vocabulary that can go either way. "Why was this pattern unusual" is a
 * question about stored evidence; "what is anomaly detection" is a question
 * about a concept. The definition test below separates them.
 */
const PRODUCT_TOPIC = /\b(anomal\w*|unusual|outlier|pattern|evidence|event|events|condition|conditions|changed|change|changes|meaningful|alert|alerts|note|stale|freshness|live data|demo replay)\b/i;

/** Phrasing that asks what something means rather than what happened. */
const DEFINITION = /\b(what is|what's|whats|what are|what does|what do|define|definition of|meaning of|difference between|how is .*(calculated|computed|measured|derived)|how do you calculate|explain the (concept|term|idea))\b/i;

/** A provider-suffixed ticker is unambiguous: INFY.NS is not a sentence. */
const SUFFIXED_TICKER = /\b[A-Z][A-Z0-9-]{0,9}\.(NS|BO)\b/i;

/** Generic words in a company's registered name that identify no company. */
const NAME_NOISE = new Set([
  "limited", "ltd", "inc", "incorporated", "corp", "corporation", "plc", "company",
  "companies", "holdings", "holding", "group", "industries", "industry", "the", "and",
  "co", "sa", "ag", "nv", "international", "global", "technologies", "services",
]);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way a user might name one watched row: symbol, root, distinctive name words. */
function namesFor(row: WatchedSecurity): string[] {
  const root = row.symbol.replace(/\.[A-Z]{1,3}$/i, "");
  const words = (row.name ?? "").split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 4 && !NAME_NOISE.has(word.toLowerCase()));
  return [row.symbol, root, ...words].filter((value) => value.length >= 2);
}

/**
 * The watched security a question is about, or null.
 *
 * Scoped to this user's own watchlist by construction: shorthand like "INFY" or
 * "Reliance" resolves only against rows they already watch, never against a
 * global symbol universe, so a question cannot widen what it can reach.
 */
export function matchWatchedSymbol(question: string, watchlist: WatchedSecurity[]): string | null {
  let best: { symbol: string; length: number } | null = null;
  for (const row of watchlist) {
    for (const name of namesFor(row)) {
      if (!new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w-])`, "i").test(question)) continue;
      if (!best || name.length > best.length) best = { symbol: row.symbol, length: name.length };
    }
  }
  return best?.symbol ?? null;
}

/**
 * Routing decision.
 *
 * `mode` is the user's explicit selection in the conversation control. It can
 * force grounded or general, but it cannot turn an advisory question into an
 * answerable one.
 */
export function classifyAsk(question: string, watchlist: WatchedSecurity[], mode?: string | null): AskIntent {
  const text = question.trim();
  if (!text) return "GROUNDED";
  if (ADVICE_QUESTION.test(text)) return "ADVISORY";
  if (mode === "THESIS DATA") return "GROUNDED";
  if (mode === "GENERAL") return "GENERAL";
  // Owning words, an unambiguous ticker, or a company this user actually
  // watches: all three make it their data, whatever else the sentence says.
  if (OWNERSHIP.test(text) || SUFFIXED_TICKER.test(text)) return "GROUNDED";
  if (matchWatchedSymbol(text, watchlist)) return "GROUNDED";
  // Only now does phrasing decide: "what is an anomaly" is a concept question,
  // "why was this session unusual" is a question about something recorded.
  if (DEFINITION.test(text)) return "GENERAL";
  return PRODUCT_TOPIC.test(text) ? "GROUNDED" : "GENERAL";
}
