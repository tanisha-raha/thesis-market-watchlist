import Link from "next/link";
import type { Digest, EvidenceEntry } from "@/lib/digest";
import type { StoredThesis, HistoryPoint } from "@/lib/presentation";
import type { WatchlistRow } from "@/lib/watchlist";
import { DashboardCard, EmptyState, Icon, StatusBadge, CompanyMark, formatPrice, PriceChange, FreshnessBadge } from "@/components/ui";
import { AddStockButton } from "@/components/workspace-controls";
import { PriceChart } from "@/components/price-chart";
import { formatAge, formatIST } from "@/lib/time";

export function HeroPanel() {
  return <section className="hero-panel"><div><h1>YOUR WATCHLIST.<br />THE CONTEXT BEHIND THE MOVE.</h1><p>See what changed, how unusual it was, and whether it<br className="hidden sm:block" /> matters to why you’re watching.</p></div><div className="hero-aside">Markets move.<br />Keep your reason in view.<span /></div></section>;
}
export function SummaryMetrics({ rows, d, theses, benchmark, demo = false }: { rows: WatchlistRow[]; d: Digest; theses: StoredThesis[]; benchmark?: { price: string; previousClose: string | null; asOf: Date; marketState: string | null } | null; demo?: boolean }) {
  const count = d.contradictions.length + d.triggers.length + d.missed.length + d.anomalies.length;
  const monitored = theses.filter((thesis) => thesis.type !== "none").length;
  return <div className="summary-grid">
    {benchmark ? <section className="metric-card"><span className="eyebrow">NIFTY 50 <span className="text-faint">· ^NSEI</span></span><strong className="num">{Number(benchmark.price).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><div className="metric-foot"><PriceChange value={benchmark.previousClose && Number(benchmark.previousClose) !== 0 ? (Number(benchmark.price) / Number(benchmark.previousClose) - 1) * 100 : null} /><FreshnessBadge asOf={benchmark.asOf} marketState={benchmark.marketState} demo={demo} /></div></section>
      : <section className="metric-card"><span className="eyebrow">YOUR WORKSPACE</span><strong>Every move, in context.</strong><span className="text-meta text-muted">NSE equities · personal watchlist</span></section>}
    <section className="metric-card"><div className="metric-label"><span className="eyebrow">MY WATCHLIST</span><Icon name="watchlist" /></div><strong className="num">{rows.length}<small> stocks</small></strong><span className="text-meta text-muted">{rows.length ? "Your ideas, in one place" : "Start with a company you follow"}</span></section>
    <section className="metric-card"><div className="metric-label"><span className="eyebrow">STRUCTURED THESES</span><Icon name="shield" /></div><strong className="num">{monitored}<small> conditions</small></strong><span className="text-meta text-muted">{rows.length - monitored} just watching</span></section>
    <section className="metric-card"><div className="metric-label"><span className="eyebrow">WHILE YOU WERE AWAY</span><Icon name="activity" /></div><strong className="num">{count}<small> updates</small></strong><span className="text-meta text-muted">{d.missed.length} happened and reversed</span></section>
  </div>;
}
export function DigestPreview({ d }: { d: Digest }) {
  const events = [
    ...d.contradictions.map((event) => ({ ...event, headline: "Thesis contradicted", status: "CONTRADICTED", resolvedAt: null as Date | null })),
    ...d.triggers.map((event) => ({ ...event, headline: `Condition met: ${event.conditionText}`, status: "TRIGGERED", resolvedAt: null as Date | null })),
    ...d.missed.map((event) => ({ ...event, headline: event.headline, status: "MISSED" })),
    ...d.anomalies.map((event) => ({ ...event, headline: event.signalType.replace(/_/g, " "), status: "DETECTED" })),
  ];
  return <DashboardCard title="While You Were Away" meta={<span className="count-chip">{events.length}</span>} className="digest-preview">
    {events.length ? <div className="preview-events">{events.slice(0, 4).map((event, index) => <Link href={`/symbol/${encodeURIComponent(event.symbol)}`} key={`${event.symbol}-${index}`} className="preview-event"><div className="flex items-start gap-2.5"><CompanyMark symbol={event.symbol} /><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><strong>{event.symbol.replace(".NS", "")}</strong><time title={`${formatIST(event.occurredAt)} IST`}>{formatAge(event.occurredAt)}</time></div><p>{event.headline}</p><div className="preview-evidence">{event.evidence.slice(0, 2).map((entry) => `${entry.label}: ${entry.value}`).join(" · ")}</div><div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge state={event.status} />{event.resolvedAt && <span className="text-micro text-muted">Reversed {formatIST(event.resolvedAt)} IST</span>}</div></div></div></Link>)}</div>
      : <EmptyState title="No meaningful changes since your last check." description="Your next detected trigger, contradiction, or reversal will appear here." icon="digest" />}
    <Link href="/digest" className="panel-link">View full digest <Icon name="arrow" size={15} /></Link>
  </DashboardCard>;
}
export const thesisLabel = (type: string) => ({ price_range: "Waiting for a dip", breakout: "Watching for a breakout", momentum_up: "Tracking momentum", momentum_down: "Tracking a decline", volatility_watch: "Watching for unusual moves", volume_expansion: "Watching for volume expansion", none: "Just watching" }[type] ?? type.replace(/_/g, " "));
export function thesisCondition(type: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  if (type === "price_range" && typeof p.low === "number" && typeof p.high === "number") return `${formatPrice(p.low)} – ${formatPrice(p.high)}`;
  if (type === "breakout" && typeof p.level === "number") return `Above ${formatPrice(p.level)}`;
  return thesisLabel(type);
}
export function ThesisCard({ thesis, company, children }: { thesis?: StoredThesis; company?: string | null; children?: React.ReactNode }) {
  return <DashboardCard title="My Thesis" action={thesis && <StatusBadge state={thesis.state} />} className="thesis-card">
    <div className="panel-body">{thesis ? <><p className="font-medium text-ink">{company ?? thesis.symbol}</p><p className="text-meta text-muted mt-1">{thesisLabel(thesis.type)}</p>{thesis.note && <blockquote className="thesis-note">“{thesis.note}”</blockquote>}<div className="thesis-condition"><span className="eyebrow">{thesis.type === "none" ? "MONITORING" : "YOUR CONDITION"}</span><p>{thesisCondition(thesis.type, thesis.params)}</p></div><p className="text-micro text-faint mt-3">Recorded {formatIST(thesis.createdAt)} IST. Your note is displayed as written.</p></> : <EmptyState title="No thesis recorded." description="You’re just watching. Add a structured condition to give a company’s next move personal context." icon="watchlist" />}{children}</div>
  </DashboardCard>;
}
export function EvidencePanel({ entries, state, href, occurredAt }: { entries: EvidenceEntry[]; state?: string | null; href?: string; occurredAt?: Date | null }) {
  return <DashboardCard title="Thesis Status / Evidence" action={state && <StatusBadge state={state} />} id="evidence">
    {entries.length ? <dl className="evidence-rows">{entries.map((entry, i) => <div key={`${entry.label}-${i}`}><dt><span className="evidence-dot" />{entry.label}</dt><dd className="num">{entry.value}{entry.basis && <small>{entry.basis}</small>}</dd></div>)}</dl> : <EmptyState title="No stored evidence yet" description="Evidence appears when THESIS records a detected event for this symbol." icon="shield" />}
    {occurredAt && <p className="panel-caption">Stored event · {formatIST(occurredAt)} IST. Values reflect that event, not the latest quote.</p>}
    {href && <Link className="panel-link" href={href}>View full evidence <Icon name="arrow" size={15} /></Link>}
  </DashboardCard>;
}
export function ThesisOverview({ theses }: { theses: StoredThesis[] }) {
  return <DashboardCard title="Your Thesis Monitor"><div className="thesis-monitor"><div><span className="num text-up">{theses.filter((t) => t.state === "TRIGGERED").length}</span><span>Triggered</span></div><div><span className="num text-down">{theses.filter((t) => t.state === "CONTRADICTED").length}</span><span>Contradicted</span></div><div><span className="num">{theses.filter((t) => ["WATCHING", "STILL_VALID"].includes(t.state)).length}</span><span>Watching / valid</span></div></div><p className="panel-caption">Your structured conditions, evaluated against market evidence.</p></DashboardCard>;
}
export function FeaturedStock({ row, points, demo = false }: { row?: WatchlistRow; points: HistoryPoint[]; demo?: boolean }) {
  return <DashboardCard title="Featured Stock" meta={<span className="eyebrow">FROM YOUR WATCHLIST</span>}>
    {row ? <div className="panel-body"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><CompanyMark symbol={row.symbol} /><div className="min-w-0"><h3 className="font-medium truncate">{row.name ?? row.symbol}</h3><span className="text-meta text-faint">{row.symbol}</span></div></div><span className="status-badge neutral">NSE</span></div><div className="mt-4 flex flex-wrap justify-between items-end gap-2"><div><div className="num text-title">{formatPrice(row.price)}</div><PriceChange value={row.changePercent} /><span className="text-micro text-faint ml-2">vs prev close</span></div><FreshnessBadge asOf={row.asOf} marketState={row.marketState} health={row.health} demo={demo} /></div><PriceChart points={points} compact /><Link href={`/symbol/${encodeURIComponent(row.symbol)}`} className="button-secondary w-fit mt-3">View details <Icon name="arrow" size={15} /></Link></div>
      : <EmptyState title="Start with a company, stay for the context." description="Add your first stock to see its price, history, thesis, and evidence together." icon="watchlist"><AddStockButton /></EmptyState>}
  </DashboardCard>;
}
