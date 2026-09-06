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

/** Company-shaped fragments in a message, in the order they appear. */
export function companyCandidates(message: string): string[] {
  return message
    .replace(/[?!.]+$/g, "")
    .split(SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => CANDIDATE.test(part) && part.split(" ").every((word) => !STOP.has(word.toLowerCase())))
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
