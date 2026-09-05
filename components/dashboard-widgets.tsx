import Link from "next/link";
import type { EvidenceEntry } from "@/lib/digest";
import type { StoredThesis } from "@/lib/presentation";
import { DashboardCard, EmptyState, Icon, StatusBadge } from "@/components/ui";
import { formatExchangeTime, IST } from "@/lib/time";
import { thesisCondition, thesisLabel } from "@/lib/thesis-display";

/** The thesis surfaces shared by the watchlist and the symbol page. */

export function ThesisCard({ thesis, company, currency = "INR", timeZone = IST, children }: {
  thesis?: StoredThesis; company?: string | null; currency?: string | null; timeZone?: string; children?: React.ReactNode;
}) {
  return <DashboardCard title="My Thesis" action={thesis && <StatusBadge state={thesis.state} />} className="thesis-card">
    <div className="panel-body">{thesis ? <>
      <p className="font-medium text-ink">{company ?? thesis.symbol}</p>
      <p className="text-meta text-muted mt-1">{thesisLabel(thesis.type)}</p>
      {thesis.note && <blockquote className="thesis-note">“{thesis.note}”</blockquote>}
      <div className="thesis-condition"><span className="eyebrow">{thesis.type === "none" ? "MONITORING" : "YOUR CONDITION"}</span><p>{thesisCondition(thesis.type, thesis.params, currency)}</p></div>
      <p className="text-micro text-faint mt-3">Recorded {formatExchangeTime(thesis.createdAt, timeZone)}. Your note is displayed as written.</p>
    </> : <EmptyState title="No thesis recorded." description="You’re just watching. Add a structured condition to give a company’s next move personal context." icon="watchlist" />}{children}</div>
  </DashboardCard>;
}

export function EvidencePanel({ entries, state, href, occurredAt, timeZone = IST }: {
  entries: EvidenceEntry[]; state?: string | null; href?: string; occurredAt?: Date | null; timeZone?: string;
}) {
  return <DashboardCard title="Thesis Status / Evidence" action={state && <StatusBadge state={state} />} id="evidence">
    {entries.length
      ? <dl className="evidence-rows">{entries.map((entry, i) => <div key={`${entry.label}-${i}`}><dt><span className="evidence-dot" />{entry.label}</dt><dd className="num">{entry.value}{entry.basis && <small>{entry.basis}</small>}</dd></div>)}</dl>
      : <EmptyState title="No stored evidence yet" description="Evidence appears when THESIS records a detected event for this symbol." icon="shield" />}
    {occurredAt && <p className="panel-caption">Stored event · {formatExchangeTime(occurredAt, timeZone)}. Values reflect that event, not the latest quote.</p>}
    {href && <Link className="panel-link" href={href}>View full evidence <Icon name="arrow" size={15} /></Link>}
  </DashboardCard>;
}
