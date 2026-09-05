"use client";

import { useActionState, useEffect, useState } from "react";
import { addToWatchlist, type FormState } from "@/app/actions";
import type { SearchResult } from "@/lib/market/types";

const FIELD =
  "w-full rounded-sm border border-line bg-surface px-3 py-2 text-body outline-none " +
  "transition-colors focus:border-accent";

/**
 * The thesis question. One option, offered once, never required.
 *
 * `none` is preselected, so submitting the form untouched adds the symbol in a
 * single click. This is the difference between capturing intent and demanding
 * it — a form that blocks on "why?" gets abandoned or answered dishonestly, and
 * a dishonest thesis is worse than none because we would monitor it.
 */
const OPTIONS: { value: string; label: string; needs: "range" | "level" | null }[] = [
  { value: "none", label: "Just watching", needs: null },
  { value: "price_range", label: "Waiting for a dip", needs: "range" },
  { value: "breakout", label: "Watching for a breakout", needs: "level" },
  { value: "momentum_up", label: "Tracking momentum", needs: null },
  { value: "volatility_watch", label: "Watching for unusual moves", needs: null },
];

export function AddSymbolForm({ initialSymbol = "", onAdded }: { initialSymbol?: string; onAdded?: () => void }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addToWatchlist, undefined);
  const [query, setQuery] = useState(initialSymbol);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [type, setType] = useState("none");
  const [searchState, setSearchState] = useState<"idle" | "loading" | "empty" | "error">("idle");

  const needs = OPTIONS.find((o) => o.value === type)?.needs ?? null;

  // Debounced search, aborting in flight so a slow response cannot overwrite a
  // newer query's results.
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setSearchState("idle"); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        setSearchState("loading");
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!res.ok) throw new Error("Search failed");
        const found = await res.json() as SearchResult[];
        setResults(found);
        setSearchState(found.length === 0 ? "empty" : "idle");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setSearchState("error");
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    if (state && !state.error) { setQuery(""); setResults([]); setType("none"); setSearchState("idle"); onAdded?.(); }
  }, [state, onAdded]);

  return (
    <form action={formAction} className="add-stock-form" aria-busy={pending}>
      <div className="relative">
        <label className="label" htmlFor="symbol">Find a company</label>
        <div className="mt-1 flex gap-2">
          <input
            id="symbol" name="symbol" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for a company (e.g. Infosys, Reliance, Apple...)" autoComplete="off" className={FIELD}
          />
          <button
            type="submit" disabled={pending || !query.trim()}
            className="button-primary shrink-0 disabled:opacity-40"
          >
            {pending ? "Adding…" : "Add"}
          </button>
        </div>

        {/* The same global search as the top bar — one company index for the
            whole product, not a second NSE-only one hidden in this dialog. */}
        {results.length > 0 && (
          <ul className="add-search-results absolute z-10 mt-1 w-full overflow-hidden rounded-sm border border-line bg-surface shadow-sm">
            {results.map((r) => (
              <li key={r.symbol}>
                <button
                  type="button" onClick={() => { setQuery(r.symbol); setResults([]); }}
                  className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-body transition-colors hover:bg-accent-soft"
                >
                  <span className="truncate font-medium">{r.name ?? r.symbol}</span>
                  <span className="shrink-0 text-meta text-muted"><span className="num">{r.symbol}</span>{r.exchange ? ` · ${[r.exchange, r.market].filter(Boolean).join(" · ")}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {searchState === "loading" && <p className="mt-1 text-micro text-faint">Searching companies…</p>}
        {searchState === "empty" && <p className="mt-1 text-micro text-faint">No supported companies found. You can still enter a ticker directly (for example AAPL or INFY.NS).</p>}
        {searchState === "error" && <p className="mt-1 text-micro text-down">Search is unavailable. You can still enter a ticker directly.</p>}
      </div>

      <fieldset className="mt-5 border-t border-line pt-4">
        <legend className="sr-only">Why are you watching?</legend>
        <p className="label">
          Why are you watching? <span className="normal-case tracking-normal">— optional</span>
        </p>

        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {OPTIONS.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-center gap-1.5 text-body">
              <input
                type="radio" name="thesisType" value={o.value}
                checked={type === o.value} onChange={() => setType(o.value)}
                className="accent-accent"
              />
              <span className={type === o.value ? "text-ink" : "text-muted"}>{o.label}</span>
            </label>
          ))}
        </div>

        {needs !== null && (
          <p className="mt-3 text-micro text-faint">Enter levels in the company’s own trading currency — ₹ for an NSE listing, $ for a US one.</p>
        )}

        {needs === "range" && (
          <div className="mt-3 flex items-end gap-2">
            <label className="flex-1">
              <span className="label">Interested from</span>
              <input name="low" type="number" step="0.01" min="0" placeholder="2800" className={`${FIELD} num mt-1`} />
            </label>
            <label className="flex-1">
              <span className="label">up to</span>
              <input name="high" type="number" step="0.01" min="0" placeholder="2900" className={`${FIELD} num mt-1`} />
            </label>
          </div>
        )}

        {needs === "level" && (
          <label className="mt-3 block max-w-xs">
            <span className="label">Breakout above</span>
            <input name="level" type="number" step="0.01" min="0" placeholder="3200" className={`${FIELD} num mt-1`} />
          </label>
        )}

        <label className="mt-3 block">
          <span className="label">Note to yourself</span>
          <input
            name="note" maxLength={200} placeholder="Shown back to you as written — never interpreted"
            className={`${FIELD} mt-1`}
          />
        </label>
      </fieldset>

      {state?.error && <p className="mt-3 text-meta text-down" role="alert">{state.error}</p>}
    </form>
  );
}
