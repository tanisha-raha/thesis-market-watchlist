import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { and } from "drizzle-orm";
import { getLatestAnomaly } from "@/lib/ml/anomaly-server";
import { getThesisReplay } from "@/lib/thesis-replay-server";
import { evidenceFrom } from "@/lib/digest";
import { formatExchangeTime } from "@/lib/time";
import { signalLabel } from "@/lib/recorded-evidence";
import { DashboardCard, EmptyState, StatusBadge } from "@/components/ui";
import { Evidence } from "@/components/evidence";
import { MarketPattern } from "@/components/market-pattern";
import { RecordedEvidence } from "@/components/recorded-evidence";
import { ThesisReplay } from "@/components/thesis-replay";
import { traced } from "@/lib/trace";

/**
 * The company page's secondary surfaces, each fetching its own stored state.
 *
 * WHY THESE STREAM AND THE HEADER DOES NOT. Identity, the latest persisted price,
 * the chart and the user's own thesis are what somebody clicked a company to see,
 * so the page still awaits those. The anomaly classification, the replay walk and
 * the event history are evidence you scroll to; making the first paint wait on
 * them turned three further reads into dead time in front of the price.
 *
 * Nothing here recomputes anything. Every section reads rows that detection,
 * ingestion and the anomaly run already committed — no fit, no backfill, no quote
 * fetch — and the fallbacks are empty frames rather than invented figures.
 */

export async function MarketPatternSection({ symbol, timeZone }: { symbol: string; timeZone: string }) {
  // Read-only: the evidence recorded when the model ran, never a fit per render.
  const anomaly = await traced("symbol:anomaly", () => getLatestAnomaly(symbol).catch(() => null));
  return <MarketPattern anomaly={anomaly} timeZone={timeZone} monitored />;
}

export async function ThesisReplaySection({ userId, symbol, demo, exchange }: {
  userId: number; symbol: string; demo: boolean; exchange?: string | null;
}) {
  const replay = await traced("symbol:replay", () => getThesisReplay(userId, symbol));
  return <ThesisReplay result={replay} demo={demo} exchange={exchange} />;
}

/**
 * Detected events, the user's own verdict timeline, and the evidence recorded
 * for the most recent event — one boundary, because Recorded Evidence names the
 * event above it and the two must never disagree about which event that is.
 */
export async function SymbolEventsSection({ userId, symbol, watched, currency, timeZone, company, sessionsUsed, hasThesis }: {
  userId: number; symbol: string; watched: boolean; currency: string | null;
  timeZone: string; company: string; sessionsUsed: number; hasThesis: boolean;
}) {
  const at = (value: Date) => formatExchangeTime(value, timeZone);
  const [events, verdicts] = await Promise.all([
    traced("symbol:events", () => db.select().from(changeEvents).where(eq(changeEvents.symbol, symbol)).orderBy(desc(changeEvents.occurredAt)).limit(12)),
    // Scoped by membership in the query itself, so it no longer waits to be told
    // this user's thesis id. Same rows, one round trip earlier.
    traced("symbol:verdicts", () => watched
      ? db.select({ id: thesisEvents.id, kind: thesisEvents.kind, occurredAt: thesisEvents.occurredAt,
          conditionsMetJson: thesisEvents.conditionsMetJson, evidenceJson: thesisEvents.evidenceJson })
        .from(watchlistItems)
        .innerJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
        .innerJoin(thesisEvents, eq(thesisEvents.thesisId, theses.id))
        .where(and(eq(watchlistItems.userId, userId), eq(watchlistItems.symbol, symbol)))
        .orderBy(desc(thesisEvents.occurredAt)).limit(6)
      : Promise.resolve([])),
  ]);
  const latestEvent = events[0];
  return <>
    <div className="two-column mt-4">
      <DashboardCard title="Recent Events & Reversals" meta={<span className="count-chip">{events.length}</span>}>
        {events.length === 0
          ? <EmptyState title="No detected events recorded." description={`THESIS holds ${sessionsUsed} usable sessions for this symbol. No event evidence is available to display.`} />
          : <div className="symbol-events">{events.map((event) => <article key={event.id} className={`symbol-event ${event.id === latestEvent?.id ? "is-current" : ""}`}><div className="symbol-event-heading"><strong className="text-meta font-medium">{signalLabel(event.signalType)}</strong><StatusBadge state={event.resolvedAt ? "RESOLVED" : "DETECTED"} /></div><p className="text-micro text-faint mt-2">Occurred {at(event.occurredAt)} · detected {at(event.detectedAt)}{event.resolvedAt && ` → ${at(event.resolvedAt)} · reversed`}</p><div className="mt-3"><Evidence entries={evidenceFrom(event.explainJson as Record<string, unknown>, currency).slice(0, 5)} /></div></article>)}</div>}
      </DashboardCard>
      {watched
        ? <DashboardCard title="Thesis Timeline" meta={<span className="count-chip">{verdicts.length}</span>}>
            {verdicts.length
              ? <div className="symbol-events">{verdicts.map((verdict) => <article key={verdict.id} className="symbol-event"><div className="symbol-event-heading"><StatusBadge state={verdict.kind.toUpperCase()} /><time>{at(verdict.occurredAt)}</time></div><p className="mt-2 text-meta text-muted break-words">{(verdict.conditionsMetJson as string[]).join(", ").replace(/_/g, " ")}</p><div className="mt-3"><Evidence entries={evidenceFrom(verdict.evidenceJson as Record<string, unknown>, currency)} /></div></article>)}</div>
              : <EmptyState title="No thesis verdicts yet" description={hasThesis ? "Your saved condition has no recorded trigger or contradiction. Its current state is shown in My Thesis." : "Add a structured thesis to monitor the reason you’re watching."} icon="shield" />}
          </DashboardCard>
        : <DashboardCard title="Thesis Timeline" action={<span className="status-badge neutral">NOT WATCHED</span>}>
            <EmptyState title="No personal timeline for a company you don’t watch" description="Detected market events are shown on the left. Trigger, contradiction and missed-event verdicts are recorded against your own stated condition once you add this company." icon="shield" />
          </DashboardCard>}
    </div>
    {/* The evidence belongs to the event above it, and says which one. */}
    <RecordedEvidence
      event={latestEvent ? { signalType: latestEvent.signalType, occurredAt: latestEvent.occurredAt, resolvedAt: latestEvent.resolvedAt, explain: latestEvent.explainJson as Record<string, unknown> } : null}
      currency={currency}
      timeZone={timeZone}
      company={company} />
  </>;
}

/* -------------------------------------------------------- loading frames */
/* Final layout, no content. A placeholder never carries a number, a status or
   a date, because a figure that later changes is worse than an empty frame. */

const Frame = ({ title, className = "" }: { title: string; className?: string }) =>
  <DashboardCard title={title} className={`is-loading ${className}`}><div className="panel-body" aria-busy="true" /></DashboardCard>;

export const MarketPatternSkeleton = () => <Frame title="Market Pattern" className="mt-4" />;
export const ThesisReplaySkeleton = () => <Frame title="THESIS Replay" className="mt-4 replay-panel" />;
export const SymbolEventsSkeleton = () => <>
  <div className="two-column mt-4">
    <Frame title="Recent Events & Reversals" />
    <Frame title="Thesis Timeline" />
  </div>
  <Frame title="Recorded Evidence" className="recorded-evidence mt-4" />
</>;
