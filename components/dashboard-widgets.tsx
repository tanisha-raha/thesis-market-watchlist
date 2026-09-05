import type { StoredThesis } from "@/lib/presentation";
import { DashboardCard, EmptyState, StatusBadge } from "@/components/ui";
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
