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
          className="flex-1 rounded border border-[--color-line] bg-white px-3 py-2 text-sm outline-none focus:border-[--color-ink]"
        />
        <button
          type="submit" disabled={pending || !query.trim()}
          className="rounded bg-[--color-ink] px-4 py-2 text-sm text-white disabled:opacity-40"
        >
          {pending ? "…" : "Add"}
        </button>
      </div>

      {state?.error && <p className="mt-2 text-sm text-[--color-down]">{state.error}</p>}

      {results.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded border border-[--color-line] bg-white shadow-sm">
          {results.map((r) => (
            <li key={r.symbol}>
              <button
                type="button"
                onClick={() => { setQuery(r.symbol); setResults([]); }}
                className="flex w-full items-baseline justify-between px-3 py-2 text-left text-sm hover:bg-neutral-50"
              >
                <span className="font-medium">{r.symbol}</span>
                <span className="ml-3 truncate text-xs text-[--color-muted]">{r.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
