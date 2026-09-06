import { findConcepts } from "@/lib/finance-glossary";

/**
 * What is this turn about?
 *
 * A chat is not a sequence of unrelated questions. "Apple and Infosys" is a
 * sentence fragment with no verb; it means something only because the previous
 * turn asked which companies you were considering. "Was that unusual?" names
 * nothing at all. Routing each message on its own — which is what this used to
 * do — sends both of those to the general explainer, and the assistant appears
 * to have no memory of what it just said.
 *
 * So resolution takes the recent conversation as well as the message, and
 * produces three things the responder needs: the intent, the companies the turn
 * is about, and the concepts it is about. Entities and concepts carry forward
 * when a message refers back to them and are replaced the moment a message names
 * its own. Everything here is pure — no database, no network, no user records —
 * so every conversation in the test suite is a direct call.
 */

export type AskIntent = "ADVISORY" | "COMPARISON" | "GROUNDED" | "GENERAL";

/** The minimum a caller must know about a security to resolve a name against it. */
export type KnownSecurity = { symbol: string; name?: string | null };

/** One earlier message, as the client replays it back to the server. */
export type Turn = { role: "user" | "assistant"; text: string; category?: string | null; symbols?: string[] };

export type ResolvedTurn = {
  intent: AskIntent;
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

/** First-person or product-record words. These are never a definition request. */
const OWNERSHIP = /\b(my|mine|our|ours|watchlist|watching|watched|thesis|theses|triggered?|contradicted|missed?|digest|away|since i|replay|verdict|verdicts|holding|holdings|position|positions|portfolio)\b/i;

/**
 * Product vocabulary that can go either way. "Why was this pattern unusual" is a
 * question about stored evidence; "what is anomaly detection" is a question
 * about a concept. The definition test below separates them.
 */
const PRODUCT_TOPIC = /\b(anomal\w*|unusual|outlier|pattern|evidence|event|events|condition|conditions|changed|change|changes|meaningful|alert|alerts|note|stale|freshness|live data|demo replay|invalidate\w*|contradict\w*)\b/i;

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

/**
 * Resolve one turn against the conversation behind it.
 *
 * `mode` is the user's explicit selection in the conversation control. It can
 * force grounded or general, but it cannot turn an advisory question into an
 * answerable one.
 */
export function resolveTurn(message: string, history: Turn[], catalogue: KnownSecurity[], mode?: string | null): ResolvedTurn {
  const text = message.trim();
  const named = resolveSymbols(text, catalogue);
  const concepts = findConcepts(text).map((concept) => concept.id);
  const refers = REFERENCE.test(text);
  const base = { symbols: named, carried: false, concepts, implementation: false, metric: metricIn(text), asksComparison: COMPARE.test(text) };

  if (!text) return { ...base, intent: "GROUNDED", metric: null };
  if (ADVICE_QUESTION.test(text)) return { ...base, intent: "ADVISORY" };

  // A concept follow-up, before ownership: "How does THESIS calculate it?"
  // contains the word "thesis" and would otherwise read as a personal question.
  if (IMPLEMENTATION.test(text) && (concepts.length || (refers && carriedConcepts(history).length)) && named.length === 0) {
    return { ...base, intent: "GENERAL", implementation: true, concepts: concepts.length ? concepts : carriedConcepts(history) };
  }

  if (mode === "GENERAL" && named.length === 0) return { ...base, intent: "GENERAL" };

  // TWO OR MORE COMPANIES IS A COMPARISON. Whether the user wrote "compare
  // Apple and Infosys" or simply answered "Apple and Infosys" when asked which
  // companies they were considering, the useful reply is the same one.
  if (named.length >= 2) return { ...base, intent: "COMPARISON" };

  if (named.length === 1) return { ...base, intent: "GROUNDED" };

  // Nothing named. If this message refers back, inherit what the conversation
  // was already about rather than starting from zero.
  // Carry context only when the message actually leans on it: it refers back,
  // or it is a fragment with no concept and no definition phrasing of its own.
  // "What is a breakout?" is short, but it is a complete question.
  const leansOnContext = refers
    || (text.split(/\s+/).length <= 6 && concepts.length === 0 && !DEFINITION.test(text));
  const carried = leansOnContext ? carriedSymbols(history, catalogue) : [];
  if (carried.length) {
    const wantsComparison = carried.length >= 2 && (COMPARE.test(text) || base.metric != null || invitedComparison(history));
    if (wantsComparison) return { ...base, intent: "COMPARISON", symbols: carried, carried: true };
    if (mode !== "GENERAL" && !DEFINITION.test(text) && (PRODUCT_TOPIC.test(text) || INVALIDATION.test(text) || OWNERSHIP.test(text) || refers)) {
      return { ...base, intent: "GROUNDED", symbols: carried.slice(0, 1), carried: true };
    }
  }

  if (mode === "THESIS DATA") return { ...base, intent: "GROUNDED" };
  if (mode === "GENERAL") return { ...base, intent: "GENERAL" };
  if (OWNERSHIP.test(text) || SUFFIXED_TICKER.test(text)) return { ...base, intent: "GROUNDED" };
  // Only now does phrasing decide: "what is an anomaly" is a concept question,
  // "why was this session unusual" is a question about something recorded.
  if (DEFINITION.test(text)) return { ...base, intent: "GENERAL" };
  // A concept follow-up with no reference word: carry the concept anyway.
  if (concepts.length === 0 && refers && carriedConcepts(history).length) {
    return { ...base, intent: "GENERAL", concepts: carriedConcepts(history) };
  }
  return { ...base, intent: PRODUCT_TOPIC.test(text) ? "GROUNDED" : "GENERAL" };
}

/** Single-turn routing, kept for callers that have no conversation to consider. */
export function classifyAsk(question: string, watchlist: KnownSecurity[], mode?: string | null): AskIntent {
  const intent = resolveTurn(question, [], watchlist, mode).intent;
  // Without a conversation, two named companies is still a grounded question
  // about the user's own data unless the message asks for a comparison.
  return intent === "COMPARISON" && !COMPARE.test(question) ? "GROUNDED" : intent;
}
