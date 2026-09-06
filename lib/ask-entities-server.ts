import "server-only";
import { searchSymbols } from "@/lib/watchlist";

/**
 * Resolving a company THESIS does not hold yet.
 *
 * The catalogue only knows securities somebody has already added, so on a fresh
 * deployment "Apple and Infosys" resolves half a comparison and the other half
 * silently disappears. Naming a company is not the same as THESIS having data
 * about it: this turns the name into a symbol, and the comparison then says
 * plainly that nothing is recorded for it rather than leaving it out.
 *
 * Deliberately narrow. It runs only on turns that are asking for companies to be
 * set side by side, it reuses the same bounded, cached, read-only search the
 * dropdown uses, and it accepts a result only when the name really matches what
 * was typed. Nothing is persisted and no history is fetched.
 */

/** Words that separate one company from another in a list. */
const SEPARATORS = /\b(?:and|or|versus|vs\.?|against|compare[d]?|with|between)\b|[,&/]/i;
const CANDIDATE = /^[A-Za-z][A-Za-z.&'-]{1,24}(?: [A-Za-z][A-Za-z.&'-]{1,24}){0,2}$/;
const STOP = new Set(["which", "what", "how", "why", "the", "one", "them", "both", "these", "those", "this", "that", "more", "most", "better", "best", "stock", "stocks", "company", "companies", "it", "they"]);
const MAX_LOOKUPS = 3;

/**
 * A proper noun inside a sentence: "Tell me about Apple", "What does Reliance
 * Industries do?". The first word is skipped because every sentence starts
 * capitalised, and stopwords are dropped so "What" and "Which" never qualify.
 */
const PROPER_NOUN = /\b[A-Z][A-Za-z.&'-]{2,}(?:\s+[A-Z][A-Za-z.&'-]{2,}){0,2}\b/g;

/** Company-shaped fragments in a message, in the order they appear. */
export function companyCandidates(message: string): string[] {
  const trimmed = message.replace(/[?!.]+$/g, "");
  const usable = (part: string) => {
    const words = part.split(" ");
    if (!CANDIDATE.test(part) || words.some((word) => STOP.has(word.toLowerCase()))) return false;
    // A multi-word fragment has to look like a name — "Reliance Industries", not
    // "market volatility" — or a sentence with no separator becomes a lookup.
    return words.length === 1 || words.every((word) => /^[A-Z]/.test(word));
  };
  // Whole fragments first — "Apple and Infosys" is two of them — then proper
  // nouns found inside a longer sentence.
  const fragments = trimmed.split(SEPARATORS).map((part) => part.trim()).filter(usable);
  // A proper noun already inside a fragment is the same mention, not another one.
  const nouns = (trimmed.slice(trimmed.search(/\s/) + 1).match(PROPER_NOUN) ?? [])
    .map((part) => part.trim())
    .filter((part) => usable(part) && !fragments.some((fragment) => fragment.toLowerCase().includes(part.toLowerCase())));
  const seen = new Set<string>();
  return [...fragments, ...nouns]
    .filter((part) => { const key = part.toLowerCase(); return seen.has(key) ? false : (seen.add(key), true); })
    .slice(0, MAX_LOOKUPS);
}

const root = (symbol: string) => symbol.replace(/\.[A-Z]{1,3}$/i, "").toLowerCase();

/**
 * Symbols for the companies named in a message, beyond those already resolved.
 *
 * A search result is accepted only when the ticker root or the company name
 * actually begins with what was typed, so a fuzzy match cannot quietly swap in a
 * different company than the one the user meant.
 */
export async function resolveNamedCompanies(message: string): Promise<string[]> {
  const taken = new Set<string>();
  const found: string[] = [];
  // Every candidate, in the order they were typed, so the comparison reads back
  // in the order it was asked for. Search answers from the stored catalogue
  // first, so a company THESIS already holds costs no provider call.
  for (const candidate of companyCandidates(message)) {
    const needle = candidate.toLowerCase();
    const results = await searchSymbols(candidate).catch(() => []);
    const match = results.find((result) =>
      root(result.symbol) === needle || (result.name ?? "").toLowerCase().startsWith(needle));
    if (match && !taken.has(match.symbol)) {
      taken.add(match.symbol);
      found.push(match.symbol);
    }
  }
  return found;
}
