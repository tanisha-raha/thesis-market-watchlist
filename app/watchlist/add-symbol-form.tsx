"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { addToWatchlist, type FormState } from "@/app/actions";
import type { SearchResult } from "@/lib/market/types";

export function AddSymbolForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addToWatchlist, undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const formRef = useRef<HTMLFormElement>(null);

  // Debounced search. Aborts the in-flight request on every keystroke so a slow
  // response cannot overwrite the results of a newer query.
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (res.ok) setResults(await res.json());
      } catch { /* aborted or offline — leave the previous results in place */ }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  useEffect(() => {
    if (state && !state.error) { setQuery(""); setResults([]); }
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="relative">
      <div className="flex gap-2">
        <input
          name="symbol" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Add a symbol — try RELIANCE.NS or search &ldquo;Infosys&rdquo;"
          autoComplete="off"
          className="flex-1 rounded-sm border border-line bg-surface px-3 py-2 text-body outline-none transition-colors focus:border-accent"
        />
        <button
          type="submit" disabled={pending || !query.trim()}
          className="rounded-sm bg-ink px-4 py-2 text-body font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? "…" : "Add"}
        </button>
      </div>

      {state?.error && <p className="mt-2 text-meta text-down" role="alert">{state.error}</p>}

      {results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-sm border border-line bg-surface shadow-sm">
          {results.map((r) => (
            <li key={r.symbol}>
              <button
                type="button"
                onClick={() => { setQuery(r.symbol); setResults([]); }}
                className="flex w-full items-baseline justify-between px-3 py-2 text-left text-body transition-colors hover:bg-accent-soft"
              >
                <span className="font-medium">{r.symbol}</span>
                <span className="ml-3 truncate text-meta text-muted">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
