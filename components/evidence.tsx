import type { EvidenceEntry } from "@/lib/digest";

/**
 * The evidence panel — the most important surface in the product.
 *
 * A definition list, never prose. Measure on the left in small caps; value on
 * the right in mono with tabular figures; the BASIS trailing in faint text so no
 * number ever floats free of what it was measured against. "2.3σ" alone is an
 * assertion; "2.3σ vs 20-day realized volatility" is a measurement.
 *
 * Deliberately no bars, gauges, or icons. A progress bar implies a scale we have
 * not defined, which is the same sin as inventing "82 out of 100" — and a
 * reviewer asking where the number came from must always get a real answer.
 * Every value here is rendered from what detection recorded, never recomputed.
 */
export function Evidence({ entries, group }: { entries: EvidenceEntry[]; group?: string }) {
  if (entries.length === 0) return null;
  return (
    <div>
      {group && <div className="label mb-1.5">{group}</div>}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        {entries.map((e) => (
          <div key={e.label} className="contents">
            <dt className="text-meta text-muted">{e.label}</dt>
            <dd className="num text-right text-body text-ink">
              {e.value}
              {e.basis && (
                <span className="ml-2 font-sans text-micro text-faint">{e.basis}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The user's own words. Always visually theirs, never restyled into our voice. */
export function UserWords({ prompt, note }: { prompt: string; note?: string | null }) {
  return (
    <div className="quoted text-body">
      <div>{prompt}</div>
      {note && <div className="mt-0.5 text-meta text-muted whitespace-pre-wrap">&ldquo;{note}&rdquo;</div>}
    </div>
  );
}
