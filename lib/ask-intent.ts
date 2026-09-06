import { findConcepts } from "@/lib/finance-glossary";

/**
 * What is this turn about?
 *
 * A chat is not a sequence of unrelated questions, and — the mistake this
 * routing made for a long time — naming a company is not the same as asking
 * about your own records. "Tell me about Apple" is a finance question that
 * happens to mention a company; "Explain my Apple thesis" is a question about
 * something THESIS stored. Routing on the company name sent both to the
 * watchlist and turned a chatbot into a query interface.
 *
 * OWNERSHIP DECIDES. Grounded means the message reached for something of the
 * user's — my, my watchlist, my thesis, while I was away, triggered, the
 * evidence THESIS recorded. Everything else is a general finance question, and a
 * general answer may still be *enriched* with stored evidence afterwards; that
 * is the responder's decision, not this one's.
 *
 * FOLLOW_UP is its own intent because a bare "why does that matter?" has no
 * content to classify. It resolves to whatever the conversation was already
 * doing, carrying the companies and concepts with it. Everything here is pure —
 * no database, no network, no user records — so every conversation in the test
 * suite is a direct call.
 */

/** The four things a message can be. FOLLOW_UP always resolves to one of the others. */
export type AskIntent = "GENERAL" | "GROUNDED_THESIS" | "ADVISORY" | "FOLLOW_UP";

/** What a FOLLOW_UP turned out to be, and what every other intent already is. */
export type ResolvedIntent = "GENERAL" | "GROUNDED_THESIS" | "ADVISORY";

/** The minimum a caller must know about a security to resolve a name against it. */
export type KnownSecurity = { symbol: string; name?: string | null };

/** One earlier message, as the client replays it back to the server. */
export type Turn = { role: "user" | "assistant"; text: string; category?: string | null; symbols?: string[] };

export type ResolvedTurn = {
  /** What the message is, before history is applied. */
  intent: AskIntent;
  /** What it turned out to be. Equal to `intent` unless that was FOLLOW_UP. */
  resolved: ResolvedIntent;
  /** Companies this turn is about, in the order they were named. */
  symbols: string[];
  /** True when those companies came from an earlier turn, not from this message. */
  carried: boolean;
  /** Concepts this turn is about, carried the same way. */
  concepts: string[];
  /** "How does THESIS calculate it?" — the concept, as this product implements it. */
  implementation: boolean;
  /** A stored measurement the user singled out, e.g. "which one is more volatile". */
  metric: ComparisonMetric | null;
  /** The message asks for things to be set side by side, however many resolved. */
  asksComparison: boolean;
};

/**
 * Asking to be told what to do. Checked first and never overridden, including
 * when the user has explicitly selected a conversation mode: a mode selector is
 * not consent to receive investment advice.
 */
export const ADVICE_QUESTION = /\b(should (?:i|we)|buy|sell|hold|invest in|investing in|investment recommend|good investment|best (?:stock|share|company|investment)|price target|recommend|predict|will .*go (?:up|down)|which stock)\b/i;

/** Asking for a way to think about something is not asking to be told what to do. */
const FRAMEWORK_QUESTION = /\b(what (?:should|do) (?:i|you|one|we) look (?:at|for)|how (?:do|would|should) (?:i|you|one|we) (?:evaluate|assess|analyse|analyze|compare|research)|what (?:factors|things) (?:should|do)|framework|criteria)\b/i;

/**
 * Reaching for something of your own.
 *
 * This is the ONLY thing that makes a question grounded. A company name does
 * not, which is the whole point: "Tell me about Reliance" is a finance question,
 * "Explain my Reliance thesis" is a question about a record.
 */
const OWNERSHIP = /\b(my|mine|our|ours|watchlist|watching|watched|thesis|theses|triggered?|contradicted|missed?|digest|while i was away|since i (?:was |last )?|replay|verdict|verdicts|holding|holdings|position|positions|portfolio|i(?:'m| am) watching|thesis recorded|recorded for me)\b/i;

/**
 * Product vocabulary that can go either way. "Why was this pattern unusual" is a
 * question about stored evidence; "what is anomaly detection" is a question
 * about a concept. The definition test below separates them.
 */
const PRODUCT_TOPIC = /\b(anomal\w*|unusual|outlier|evidence|event|events|condition|conditions|changed|changes|meaningful|alert|alerts|stale|freshness|live data|demo replay|invalidate\w*|contradict\w*|detected|thesis recorded|thesis has)\b/i;

/** Phrasing that asks what something means rather than what happened. */
const DEFINITION = /\b(what is|what's|whats|what are|what does|what do|define|definition of|meaning of|difference between|how is .*(calculated|computed|measured|derived)|how do you calculate|explain the (concept|term|idea))\b/i;

/** A provider-suffixed ticker is unambiguous: INFY.NS is not a sentence. */
const SUFFIXED_TICKER = /\b[A-Z][A-Z0-9-]{0,9}\.(NS|BO)\b/i;

/** Explicitly asking for two things to be set side by side. */
const COMPARE = /\b(compare|comparison|compared|versus|vs\.?|against each other|side by side|which (?:one|of (?:them|these|those)))\b/i;

/** Refers back rather than naming: the signal that context must be carried. */
const REFERENCE = /\b(that|it|its|this|these|those|them|they|the same|previous|earlier|before|one|ones|both|either)\b/i;

/** "How does THESIS calculate it" — the concept, as implemented here. */
const IMPLEMENTATION = /\b(thesis|you|the (?:app|product|engine|system)|here)\b[^?]*\b(use|uses|using|calculate|calculates|calculated|compute|computes|measure|measures|measured|implement|implements|apply|applies|do it|does it)\b/i;

/** Asking what would break a saved belief, in the engine's terms. */
export const INVALIDATION = /\b(invalidat\w*|contradict\w*|falsif\w*|no longer (?:holds?|valid|true)|stop(?:s)? (?:being|holding)|prove\w* (?:it|this|that|me|my)\b[^?]*wrong|break (?:it|this|that)\b)\b/i;

/** Measurements a follow-up can single out, mapped to what THESIS actually stores. */
export type ComparisonMetric = "volatility" | "movement" | "benchmark" | "anomaly" | "volume";
const METRICS: [ComparisonMetric, RegExp][] = [
  ["volatility", /\b(volatil\w*|vol|risky|riskier|choppy|swing\w*)\b/i],
  ["movement", /\b(moved?|movement|return|returns|performed?|performance|up|down|gain\w*|lost|loss)\b/i],
  ["benchmark", /\b(beta|benchmark|index|market-relative|relative to the market)\b/i],
  ["anomaly", /\b(anomal\w*|unusual|outlier|pattern)\b/i],
  ["volume", /\b(volume|traded|turnover|liquid\w*)\b/i],
];

/**
 * Words in a registered name that identify no company.
 *
 * Corporate boilerplate, plus ordinary English. A listed company really can be
 * called "Other User Only Limited", and matching on "user" or "only" would then
 * make every sentence containing those words a question about that company. A
 * name word has to be distinctive before it may resolve to a security.
 */
const NAME_NOISE = new Set([
  "limited", "ltd", "inc", "incorporated", "corp", "corporation", "plc", "company",
  "companies", "holdings", "holding", "group", "industries", "industry", "the", "and",
  "co", "sa", "ag", "nv", "international", "global", "technologies", "services",
  "products", "enterprises", "enterprise", "solutions", "systems", "capital", "finance",
  "financial", "bank", "banking", "insurance", "trust", "fund", "partners", "brands",
  // Ordinary English that shows up inside real company names.
  "only", "other", "user", "users", "first", "next", "last", "best", "more", "most",
  "than", "that", "this", "these", "those", "with", "from", "have", "will", "your",
  "about", "which", "when", "over", "into", "time", "data", "value", "market", "share",
  "shares", "stock", "stocks", "price", "prices", "trade", "trading", "index", "world",
  "national", "general", "central", "united", "state", "states", "power", "energy",
  "life", "health", "care", "home", "auto", "motor", "motors", "steel", "cement",
  "paints", "consumer", "digital", "media", "tech", "labs", "laboratories", "test",
]);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way a user might name one security: symbol, root, distinctive name words. */
function namesFor(row: KnownSecurity): string[] {
  const root = row.symbol.replace(/\.[A-Z]{1,3}$/i, "");
  const words = (row.name ?? "").split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length >= 4 && !NAME_NOISE.has(word.toLowerCase()));
  return [row.symbol, root, ...words].filter((value) => value.length >= 2);
}

const MAX_ENTITIES = 4;

/**
 * Every security named in a message, in the order they appear.
 *
 * The catalogue decides the reach. The responder passes the user's watchlist
 * when the answer would be personal, and the shared securities catalogue when it
 * would be market evidence — the same market data any authenticated user can
 * already open a company page to see. Longest match wins, so "Reliance
 * Industries" resolves once, not twice.
 */
export function resolveSymbols(message: string, catalogue: KnownSecurity[]): string[] {
  const hits: { symbol: string; at: number; length: number }[] = [];
  for (const row of catalogue) {
    for (const name of namesFor(row)) {
      const found = new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w-])`, "i").exec(message);
      if (found) hits.push({ symbol: row.symbol, at: found.index, length: name.length });
    }
  }
  hits.sort((a, b) => a.at - b.at || b.length - a.length);
  const taken: typeof hits = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.symbol)) continue;
    // A shorter name inside a longer one already claimed is the same mention.
    if (taken.some((other) => hit.at < other.at + other.length && other.at < hit.at + hit.length)) continue;
    seen.add(hit.symbol);
    taken.push(hit);
  }
  return taken.slice(0, MAX_ENTITIES).map((hit) => hit.symbol);
}

/** The single watched security a message is about, or null. Single-turn helper. */
export function matchWatchedSymbol(question: string, watchlist: KnownSecurity[]): string | null {
  return resolveSymbols(question, watchlist)[0] ?? null;
}

/** Companies the recent conversation was about, most recent first. */
function carriedSymbols(history: Turn[], catalogue: KnownSecurity[]): string[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    const named = turn.symbols?.length ? turn.symbols : resolveSymbols(turn.text, catalogue);
    if (named.length) return named.slice(0, MAX_ENTITIES);
  }
  return [];
}

/** Concepts the recent conversation was about, most recent first. */
function carriedConcepts(history: Turn[]): string[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const found = findConcepts(history[i].text).map((concept) => concept.id);
    if (found.length) return found;
  }
  return [];
}

/** Did the assistant just decline advice and invite a comparison? */
function invitedComparison(history: Turn[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    return history[i].category === "NON-ADVISORY" || history[i].category === "COMPARISON";
  }
  return false;
}

function metricIn(message: string): ComparisonMetric | null {
  return METRICS.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
}

/** What the previous assistant turn was doing, so a bare follow-up can continue it. */
function previousIntent(history: Turn[]): ResolvedIntent | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== "assistant") continue;
    if (turn.category === "THESIS DATA") return "GROUNDED_THESIS";
    if (turn.category) return "GENERAL";
  }
  return null;
}

/**
 * A message with no content of its own: it only means something after the last
 * one. A proper noun anywhere but the first word IS content — "Tell me about
 * Apple" is four words and a fresh subject, not a continuation.
 */
const NAMES_SOMETHING = /\s[A-Z][A-Za-z.&'-]{2,}/;

/**
 * Words that carry no subject: interrogatives, auxiliaries, articles,
 * prepositions and the small talk around a question. A message built only from
 * these is elliptical — "Why?", "How so?", "Tell me more" — and means nothing
 * without the turn before it. Anything else is a subject the message brought
 * with it.
 */
const FUNCTION_WORDS = new Set([
  "why", "how", "what", "whats", "when", "where", "who", "whom", "whose",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "done",
  "can", "could", "would", "should", "shall", "will", "may", "might", "must", "has", "have", "had",
  "the", "a", "an", "and", "or", "but", "if", "so", "then", "than", "as", "at", "by",
  "of", "to", "in", "on", "for", "from", "with", "about", "into", "over", "up", "down",
  "more", "less", "most", "least", "again", "also", "too", "even", "just", "really",
  "please", "tell", "show", "explain", "say", "give", "me", "us", "my", "our",
  "ok", "okay", "yes", "no", "not", "still", "else", "now", "here", "there", "sure",
]);

/**
 * Does the message name its own subject?
 *
 * This is the whole fix for a narrow misroute: "Why do companies issue shares?"
 * is five words with no pronoun, and a bare word count called that a follow-up,
 * so asked straight after a grounded answer it inherited the user's records and
 * was answered from them. It brings "companies", "issue" and "shares" with it —
 * it is a finance question that happens to be short, and short is not the same
 * as referential.
 */
function hasOwnSubject(text: string): boolean {
  return text.toLowerCase().split(/[^a-z']+/)
    .some((word) => word.length > 1 && !FUNCTION_WORDS.has(word) && !REFERENCE.test(word));
}

function isFollowUp(text: string, concepts: string[], named: string[]): boolean {
  if (OWNERSHIP.test(text) || DEFINITION.test(text)) return false;
  if (named.length || concepts.length || NAMES_SOMETHING.test(text)) return false;
  // A reference word points at the last turn whatever else is in the sentence.
  if (REFERENCE.test(text)) return true;
  // Otherwise only a short message with no subject of its own is a follow-up.
  return text.split(/\s+/).length <= 6 && !hasOwnSubject(text);
}

/**
 * Resolve one turn against the conversation behind it.
 *
 * `mode` is an optional explicit override. It can force grounded or general, but
 * it cannot turn an advisory question into an answerable one.
 */
export function resolveTurn(message: string, history: Turn[], catalogue: KnownSecurity[], mode?: string | null): ResolvedTurn {
  const text = message.trim();
  const named = resolveSymbols(text, catalogue);
  const concepts = findConcepts(text).map((concept) => concept.id);
  const base = {
    symbols: named, carried: false, concepts, implementation: false,
    metric: metricIn(text), asksComparison: COMPARE.test(text),
  };
  const settle = (intent: AskIntent, resolved: ResolvedIntent, over: Partial<ResolvedTurn> = {}): ResolvedTurn =>
    ({ ...base, intent, resolved, ...over });

  if (!text) return settle("GENERAL", "GENERAL");

  // Asking to be told what to do, checked before anything else. Asking for a way
  // to think about a decision is a different question and stays general.
  if (ADVICE_QUESTION.test(text) && !FRAMEWORK_QUESTION.test(text)) return settle("ADVISORY", "ADVISORY");

  if (mode === "THESIS DATA") return settle("GROUNDED_THESIS", "GROUNDED_THESIS");
  if (mode === "GENERAL") return settle("GENERAL", "GENERAL");

  // A concept follow-up, before ownership: "How does THESIS calculate it?"
  // contains the word "thesis" and would otherwise read as a personal question.
  if (IMPLEMENTATION.test(text) && named.length === 0) {
    const carried = concepts.length ? concepts : carriedConcepts(history);
    if (carried.length) return settle("GENERAL", "GENERAL", { implementation: true, concepts: carried });
  }

  // OWNERSHIP, AND ONLY OWNERSHIP, MAKES IT GROUNDED. A company name does not.
  if (OWNERSHIP.test(text) || (PRODUCT_TOPIC.test(text) && !DEFINITION.test(text))) {
    // "Was that unusual?" is grounded AND a reference: it names no company, so
    // the one the conversation was already about comes with it.
    if (named.length === 0 && REFERENCE.test(text)) {
      const carried = carriedSymbols(history, catalogue);
      if (carried.length) return settle("GROUNDED_THESIS", "GROUNDED_THESIS", { symbols: carried.slice(0, 1), carried: true });
    }
    return settle("GROUNDED_THESIS", "GROUNDED_THESIS");
  }

  // Nothing of its own to classify: continue whatever the conversation was doing.
  if (isFollowUp(text, concepts, named)) {
    const carriedSymbolList = carriedSymbols(history, catalogue);
    const carriedConceptList = carriedConcepts(history);
    const resolved = previousIntent(history) ?? "GENERAL";
    return settle("FOLLOW_UP", resolved === "ADVISORY" ? "GENERAL" : resolved, {
      symbols: carriedSymbolList,
      concepts: carriedConceptList,
      carried: carriedSymbolList.length > 0 || carriedConceptList.length > 0,
    });
  }

  return settle("GENERAL", "GENERAL");
}

/** Single-turn routing, kept for callers with no conversation to consider. */
export function classifyAsk(question: string, watchlist: KnownSecurity[], mode?: string | null): ResolvedIntent {
  return resolveTurn(question, [], watchlist, mode).resolved;
}
