import { DashboardCard, EmptyState, StatusBadge } from "@/components/ui";
import { Evidence } from "@/components/evidence";
import { recordedEvidence } from "@/lib/recorded-evidence";
import { formatExchangeTime } from "@/lib/time";

/**
 * Recorded Evidence — what THESIS observed when an event was detected.
 *
 * Replaces a six-row diagnostics table where every figure carried the same
 * weight and a personal thesis status sat on top of market measurements as if
 * the numbers proved it. Three things changed:
 *
 *   ONE QUESTION PER SURFACE. This card answers "what did we observe", and says
 *   which event it belongs to. Why the user is watching is My Thesis; whether the
 *   combination was unusual is Market Pattern; what happened is the events list.
 *
 *   HIERARCHY. Two or three figures carry the event and get size; everything they
 *   were measured against drops to a quiet context list. A table of equals made
 *   the reader do the ranking.
 *
 *   DETECTION-TIME VALUES. Every figure is read from the event's stored evidence,
 *   never recomputed from the latest quote — the card says so plainly, because
 *   that guarantee is the reason the evidence is worth anything.
 */
export function RecordedEvidence({ event, currency, timeZone, company }: {
  event: {
    signalType: string;
    occurredAt: Date;
    resolvedAt: Date | null;
    explain: Record<string, unknown>;
  } | null;
  currency: string | null;
  timeZone: string;
  company: string;
}) {
  if (!event) {
    return <DashboardCard title="Recorded Evidence" action={<span className="eyebrow">DETECTION-TIME VALUES</span>} className="recorded-evidence mt-4">
      <EmptyState
        title="No detected event to show evidence for"
        description="When THESIS detects a meaningful change for this company, the market evidence captured at that moment appears here."
        icon="shield" />
    </DashboardCard>;
  }

  const view = recordedEvidence({ signalType: event.signalType, explain: event.explain, currency, company });
  return <DashboardCard
    title="Recorded Evidence"
    action={<StatusBadge state={event.resolvedAt ? "RESOLVED" : "DETECTED"} />}
    className="recorded-evidence mt-4">
    <div className="panel-body">
      <p className="text-meta text-muted">Market evidence captured when this event was detected.</p>
      <p className="evidence-event">
        <strong>{view.headline}</strong>
        <span>·</span>
        <time>{formatExchangeTime(event.occurredAt, timeZone)}</time>
        {event.resolvedAt && <><span>·</span><span>reversed {formatExchangeTime(event.resolvedAt, timeZone)}</span></>}
      </p>

      {view.tiles.length > 0 && <div className="evidence-tiles">
        {view.tiles.map((tile) => <div key={tile.key} className="evidence-tile">
          <span className="eyebrow">{tile.label}</span>
          <strong className="num">{tile.value}</strong>
          {tile.detail && <small>{tile.detail}</small>}
        </div>)}
      </div>}

      {view.interpretation && <p className="evidence-reading">{view.interpretation}</p>}

      {view.context.length > 0 && <div className="evidence-context">
        <span className="eyebrow">Market context</span>
        <Evidence entries={view.context} />
      </div>}
    </div>
    <p className="panel-caption">Captured at detection · values preserved from this event, not the latest quote.</p>
  </DashboardCard>;
}
