import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, quotes, symbols, symbolStats, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { evidenceFrom } from "@/lib/digest";
import { getWatchlist } from "@/lib/watchlist";
import { getStoredHistory, type StoredThesis } from "@/lib/presentation";
import { Evidence } from "@/components/evidence";
import { formatIST } from "@/lib/time";
import { acknowledge } from "@/app/actions";
import { AppShell } from "@/components/app-shell";
import { DashboardCard, EmptyState, Icon, CompanyMark, formatPrice, FreshnessBadge, PriceChange, StatusBadge } from "@/components/ui";
import { ThesisCard, EvidencePanel } from "@/components/dashboard-widgets";
import { PriceChart } from "@/components/price-chart";

export const dynamic = "force-dynamic";
export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { symbol: raw } = await params;
  const symbol = decodeURIComponent(raw);
  const [item] = await db.select({ itemId: watchlistItems.id, name: symbols.name, thesisId: theses.id, thesisType: theses.type,
    thesisNote: theses.note, thesisState: theses.state, thesisCreatedAt: theses.createdAt, paramsAdjustedAt: theses.paramsAdjustedAt,
    thesisParams: theses.paramsJson, price: quotes.price, previousClose: quotes.previousClose, asOf: quotes.asOf, marketState: quotes.marketState })
    .from(watchlistItems).innerJoin(symbols, eq(symbols.symbol, watchlistItems.symbol))
    .leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id)).leftJoin(quotes, eq(quotes.symbol, watchlistItems.symbol))
    .where(and(eq(watchlistItems.userId, user.id), eq(watchlistItems.symbol, symbol))).limit(1);
  if (!item) notFound();
  const [statsRows, events, verdicts, points, rows] = await Promise.all([
    db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1),
    db.select().from(changeEvents).where(eq(changeEvents.symbol, symbol)).orderBy(desc(changeEvents.occurredAt)).limit(12),
    item.thesisId ? db.select().from(thesisEvents).where(eq(thesisEvents.thesisId, item.thesisId)).orderBy(desc(thesisEvents.occurredAt)).limit(6) : Promise.resolve([]),
    getStoredHistory(symbol), getWatchlist(user.id),
  ]);
  const stats = statsRows[0];
  const price = item.price == null ? null : Number(item.price);
  const previousClose = item.previousClose == null ? null : Number(item.previousClose);
  const move = price != null && previousClose != null && previousClose !== 0 ? ((price - previousClose) / previousClose) * 100 : null;
  const storedParams = (item.thesisParams ?? {}) as Record<string, unknown>;
  const adjustments = (Array.isArray(storedParams.adjustments) ? storedParams.adjustments : []) as { reason: string; factor: number; affectedFrom: string; affectedTo: string; before: Record<string, number>; after: Record<string, number> }[];
  const thesis: StoredThesis | undefined = item.thesisId && item.thesisCreatedAt ? { id: item.thesisId, symbol, type: item.thesisType ?? "none", state: item.thesisState ?? "WATCHING", params: item.thesisParams, note: item.thesisNote, createdAt: item.thesisCreatedAt } : undefined;
  const evidence = verdicts[0] ? evidenceFrom(verdicts[0].evidenceJson as Record<string, unknown>) : events[0] ? evidenceFrom(events[0].explainJson as Record<string, unknown>) : [];
  const demo = process.env.THESIS_DATA_MODE === "demo";
  return <AppShell email={user.email} active="watchlist" currentSymbol={symbol} rows={rows} demo={demo}>
    <Link href="/watchlist" className="inline-flex gap-2 items-center text-meta text-faint mb-4 hover:text-accent"><span>←</span> Back to watchlist</Link>
    <header className="symbol-heading"><div className="flex items-center gap-3 min-w-0"><CompanyMark symbol={symbol} /><div className="min-w-0"><h1>{item.name ?? symbol}</h1><p className="text-meta text-faint mt-1">{symbol} <span className="mx-1">·</span> NSE <span className="mx-1">·</span> INR</p></div></div><div className="symbol-price"><div className="num text-title">{formatPrice(price)}</div><div><PriceChange value={move} /><span className="text-micro text-faint ml-2">vs prev close</span></div><FreshnessBadge asOf={item.asOf} marketState={item.marketState} health={rows.find((row) => row.symbol === symbol)?.health} demo={demo} /></div></header>
    <div className="symbol-grid"><DashboardCard title="Price History" action={<span className="status-badge neutral">DAILY CLOSE</span>}><div className="panel-body"><PriceChart points={points} /><p className="text-micro text-faint mt-3">Stored adjusted daily closes. Historical series may end before the latest quote above.</p></div></DashboardCard><ThesisCard thesis={thesis} company={item.name}>
      {item.paramsAdjustedAt && adjustments.map((a, i) => <div className="adjustment-note" key={i}><strong>Adjusted for a corporate action</strong><p className="mt-1">{a.reason} · {a.factor}× · {a.affectedFrom} to {a.affectedTo}</p>{Object.keys(a.before).map((key) => <p key={key}>{key}: <s>{formatPrice(a.before[key])}</s> → {formatPrice(a.after[key])}</p>)}</div>)}
      {item.thesisId && <form action={acknowledge} className="mt-4"><input type="hidden" name="thesisId" value={item.thesisId} /><button className="button-secondary">Keep watching</button></form>}
    </ThesisCard></div>
    <div className="two-column mt-4"><EvidencePanel state={item.thesisState} entries={evidence} occurredAt={verdicts[0]?.occurredAt ?? events[0]?.occurredAt} /><DashboardCard title="Reference Levels" action={<span className="eyebrow">ADJUSTED SERIES</span>}>
      {stats ? <><div className="panel-body"><Evidence entries={[
        { label: "52-week high", value: formatPrice(stats.high52w == null ? null : Number(stats.high52w)), basis: "adjusted closes" },
        { label: "52-week low", value: formatPrice(stats.low52w == null ? null : Number(stats.low52w)), basis: "adjusted closes" },
        { label: "20-day average", value: formatPrice(stats.ma20 == null ? null : Number(stats.ma20)) },
        { label: "Realized volatility", value: stats.realizedVol20 == null ? "—" : `${(Number(stats.realizedVol20) * 100).toFixed(2)}%`, basis: "daily, 20-day" },
        { label: "Beta", value: stats.beta60 == null ? "—" : Number(stats.beta60).toFixed(2), basis: "60-day, vs ^NSEI" },
        { label: "Sessions held", value: String(stats.sessionsUsed), basis: "traded sessions only" },
      ]} /></div><p className="panel-caption">Computed {formatIST(stats.computedAt)} IST</p></> : <EmptyState title="Reference statistics are not available yet" description="Statistics will appear after sufficient usable history has been ingested." />}
    </DashboardCard></div>
    <div className="two-column mt-4"><DashboardCard title="Recent Events & Reversals" meta={<span className="count-chip">{events.length}</span>}>
      {events.length === 0 ? <EmptyState title="No detected events recorded." description={`THESIS holds ${stats?.sessionsUsed ?? 0} usable sessions for this symbol. No event evidence is available to display.`} /> : <div className="symbol-events">{events.map((event) => <article key={event.id} className="symbol-event"><div className="symbol-event-heading"><strong className="text-meta font-medium">{event.signalType.replace(/_/g, " ")}</strong><StatusBadge state={event.resolvedAt ? "RESOLVED" : "DETECTED"} /></div><p className="text-micro text-faint mt-2">{formatIST(event.occurredAt)} IST{event.resolvedAt && ` → ${formatIST(event.resolvedAt)} IST · reversed`}</p><div className="mt-3"><Evidence entries={evidenceFrom(event.explainJson as Record<string, unknown>).slice(0, 5)} /></div></article>)}</div>}
    </DashboardCard><DashboardCard title="Thesis Timeline" meta={<span className="count-chip">{verdicts.length}</span>}>
      {verdicts.length ? <div className="symbol-events">{verdicts.map((verdict) => <article key={verdict.id} className="symbol-event"><div className="symbol-event-heading"><StatusBadge state={verdict.kind.toUpperCase()} /><time>{formatIST(verdict.occurredAt)} IST</time></div><p className="mt-2 text-meta text-muted break-words">{(verdict.conditionsMetJson as string[]).join(", ").replace(/_/g, " ")}</p><div className="mt-3"><Evidence entries={evidenceFrom(verdict.evidenceJson as Record<string, unknown>)} /></div></article>)}</div> : <EmptyState title="No thesis verdicts yet" description={thesis ? "Your saved condition has no recorded trigger or contradiction. Its current state is shown above." : "Add a structured thesis to monitor the reason you’re watching."} icon="shield" />}
    </DashboardCard></div>
  </AppShell>;
}
