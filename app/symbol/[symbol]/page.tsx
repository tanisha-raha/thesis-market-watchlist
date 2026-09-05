import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { changeEvents, quotes, symbols, symbolStats, theses, thesisEvents, watchlistItems } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { evidenceFrom } from "@/lib/digest";
import { getWatchlist } from "@/lib/watchlist";
import { getStoredHistory, type StoredThesis } from "@/lib/presentation";
import { describeSecurity } from "@/lib/securities";
import { Evidence } from "@/components/evidence";
import { formatExchangeTime } from "@/lib/time";
import { formatCount, marketLine } from "@/lib/securities";
import { acknowledge } from "@/app/actions";
import { AppShell } from "@/components/app-shell";
import { DashboardCard, EmptyState, Icon, CompanyMark, formatPrice, FreshnessBadge, PriceChange, StatusBadge } from "@/components/ui";
import { ThesisCard, EvidencePanel } from "@/components/dashboard-widgets";
import { PriceChart } from "@/components/price-chart";
import { ThesisReplay } from "@/components/thesis-replay";
import { getThesisReplay } from "@/lib/thesis-replay-server";

export const dynamic = "force-dynamic";
export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const { symbol: raw } = await params;
  const symbol = decodeURIComponent(raw);
  const [item] = await db.select({ itemId: watchlistItems.id, name: symbols.name, exchange: symbols.exchange,
    currency: symbols.currency, timeZone: symbols.exchangeTimezone, thesisId: theses.id, thesisType: theses.type,
    thesisNote: theses.note, thesisState: theses.state, thesisCreatedAt: theses.createdAt, paramsAdjustedAt: theses.paramsAdjustedAt,
    thesisParams: theses.paramsJson, price: quotes.price, previousClose: quotes.previousClose, asOf: quotes.asOf, marketState: quotes.marketState })
    .from(watchlistItems).innerJoin(symbols, eq(symbols.symbol, watchlistItems.symbol))
    .leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id)).leftJoin(quotes, eq(quotes.symbol, watchlistItems.symbol))
    .where(and(eq(watchlistItems.userId, user.id), eq(watchlistItems.symbol, symbol))).limit(1);
  if (!item) notFound();
  const [statsRows, events, verdicts, points, rows, replay] = await Promise.all([
    db.select().from(symbolStats).where(eq(symbolStats.symbol, symbol)).limit(1),
    db.select().from(changeEvents).where(eq(changeEvents.symbol, symbol)).orderBy(desc(changeEvents.occurredAt)).limit(12),
    item.thesisId ? db.select().from(thesisEvents).where(eq(thesisEvents.thesisId, item.thesisId)).orderBy(desc(thesisEvents.occurredAt)).limit(6) : Promise.resolve([]),
    getStoredHistory(symbol), getWatchlist(user.id), getThesisReplay(user.id, symbol),
  ]);
  const stats = statsRows[0];
  // Exchange, currency and clock for THIS security. Every number and timestamp
  // below renders through it — no page-level assumption of NSE, ₹ or IST.
  const security = rows.find((row) => row.symbol === symbol)?.security
    ?? describeSecurity({ symbol, name: item.name, exchange: item.exchange, currency: item.currency, timeZone: item.timeZone });
  const money = (value: number | null) => formatPrice(value, security.currency);
  const at = (value: Date) => formatExchangeTime(value, security.timeZone);
  const price = item.price == null ? null : Number(item.price);
  const previousClose = item.previousClose == null ? null : Number(item.previousClose);
  const move = price != null && previousClose != null && previousClose !== 0 ? ((price - previousClose) / previousClose) * 100 : null;
  const storedParams = (item.thesisParams ?? {}) as Record<string, unknown>;
  const adjustments = (Array.isArray(storedParams.adjustments) ? storedParams.adjustments : []) as { reason: string; factor: number; affectedFrom: string; affectedTo: string; before: Record<string, number>; after: Record<string, number> }[];
  const thesis: StoredThesis | undefined = item.thesisId && item.thesisCreatedAt ? { id: item.thesisId, symbol, type: item.thesisType ?? "none", state: item.thesisState ?? "WATCHING", params: item.thesisParams, note: item.thesisNote, createdAt: item.thesisCreatedAt } : undefined;
  const evidence = verdicts[0] ? evidenceFrom(verdicts[0].evidenceJson as Record<string, unknown>, security.currency)
    : events[0] ? evidenceFrom(events[0].explainJson as Record<string, unknown>, security.currency) : [];
  const demo = process.env.THESIS_DATA_MODE === "demo";
  return <AppShell email={user.email} displayName={user.displayName} active="watchlist" currentSymbol={symbol} rows={rows} demo={demo}>
    <div className="symbol-toolbar"><Link href="/watchlist" className="inline-flex gap-2 items-center text-meta text-faint hover:text-accent"><span>←</span> Back to watchlist</Link><Link className="button-secondary" href={`/ask?symbol=${encodeURIComponent(symbol)}`}><Icon name="chat" size={15} />Ask THESIS about this stock</Link></div>
    <header className="symbol-heading"><div className="flex items-center gap-3 min-w-0"><CompanyMark symbol={symbol} /><div className="min-w-0"><h1>{item.name ?? symbol}</h1><p className="text-meta text-faint mt-1">{symbol}{marketLine(security) && <> <span className="mx-1">·</span> {marketLine(security)}</>}{security.currency && <> <span className="mx-1">·</span> {security.currency}</>}</p></div></div><div className="symbol-price"><div className="num text-title">{money(price)}</div><div><PriceChange value={move} /><span className="text-micro text-faint ml-2">vs prev close</span></div><FreshnessBadge asOf={item.asOf} marketState={item.marketState} health={rows.find((row) => row.symbol === symbol)?.health} demo={demo} timeZone={security.timeZone} /><p className="text-micro text-faint mt-1">{item.asOf ? at(item.asOf) : "No quote received yet"}</p></div></header>
    <div className="symbol-grid"><DashboardCard title="Price History" action={<span className="status-badge neutral">DAILY CLOSE</span>}><div className="panel-body"><PriceChart points={points} exchange={security.exchange} /><p className="text-micro text-faint mt-3">Stored adjusted daily closes. Historical series may end before the latest quote above.</p></div></DashboardCard><ThesisCard thesis={thesis} company={item.name} currency={security.currency} timeZone={security.timeZone}>
      {item.paramsAdjustedAt && adjustments.map((a, i) => <div className="adjustment-note" key={i}><strong>Adjusted for a corporate action</strong><p className="mt-1">{a.reason} · {a.factor}× · {a.affectedFrom} to {a.affectedTo}</p>{Object.keys(a.before).map((key) => <p key={key}>{key}: <s>{money(a.before[key])}</s> → {money(a.after[key])}</p>)}</div>)}
      {item.thesisId && <form action={acknowledge} className="mt-4"><input type="hidden" name="thesisId" value={item.thesisId} /><button className="button-secondary">Keep watching</button></form>}
    </ThesisCard></div>
    <ThesisReplay result={replay} demo={demo} exchange={security.exchange} />
    <div className="two-column mt-4"><EvidencePanel state={item.thesisState} entries={evidence} occurredAt={verdicts[0]?.occurredAt ?? events[0]?.occurredAt} timeZone={security.timeZone} /><DashboardCard title="Reference Levels" action={<span className="eyebrow">ADJUSTED SERIES</span>}>
      {stats ? <><div className="panel-body"><Evidence entries={[
        { label: "52-week high", value: money(stats.high52w == null ? null : Number(stats.high52w)), basis: "adjusted closes" },
        { label: "52-week low", value: money(stats.low52w == null ? null : Number(stats.low52w)), basis: "adjusted closes" },
        { label: "20-day average", value: money(stats.ma20 == null ? null : Number(stats.ma20)) },
        { label: "20-day high / low", value: `${money(stats.high20 == null ? null : Number(stats.high20))} / ${money(stats.low20 == null ? null : Number(stats.low20))}`, basis: "adjusted closes" },
        { label: "Median usable volume", value: formatCount(stats.medianVolume20 == null ? null : Number(stats.medianVolume20), security.currency), basis: "20 sessions" },
        { label: "Realized volatility", value: stats.realizedVol20 == null ? "—" : `${(Number(stats.realizedVol20) * 100).toFixed(2)}%`, basis: "daily, 20-day" },
        // Beta is measured against this security's own market index, and says so
        // — or says it is unavailable, rather than borrowing another market's.
        { label: "Beta", value: stats.beta60 == null ? "—" : Number(stats.beta60).toFixed(2),
          basis: stats.beta60 == null
            ? security.benchmark ? `no ${security.benchmark} history stored yet` : "no benchmark for this market"
            : `60-day, vs ${security.benchmark ?? "benchmark"}` },
        { label: "Sessions held", value: String(stats.sessionsUsed), basis: "traded sessions only" },
      ]} /></div><p className="panel-caption">Computed {at(stats.computedAt)}</p></> : <EmptyState title="Reference statistics are not available yet" description="Statistics will appear after sufficient usable history has been ingested." />}
    </DashboardCard></div>
    <div className="two-column mt-4"><DashboardCard title="Recent Events & Reversals" meta={<span className="count-chip">{events.length}</span>}>
      {events.length === 0 ? <EmptyState title="No detected events recorded." description={`THESIS holds ${stats?.sessionsUsed ?? 0} usable sessions for this symbol. No event evidence is available to display.`} /> : <div className="symbol-events">{events.map((event) => <article key={event.id} className="symbol-event"><div className="symbol-event-heading"><strong className="text-meta font-medium">{event.signalType.replace(/_/g, " ")}</strong><StatusBadge state={event.resolvedAt ? "RESOLVED" : "DETECTED"} /></div><p className="text-micro text-faint mt-2">Occurred {at(event.occurredAt)} · detected {at(event.detectedAt)}{event.resolvedAt && ` → ${at(event.resolvedAt)} · reversed`}</p><div className="mt-3"><Evidence entries={evidenceFrom(event.explainJson as Record<string, unknown>, security.currency).slice(0, 5)} /></div></article>)}</div>}
    </DashboardCard><DashboardCard title="Thesis Timeline" meta={<span className="count-chip">{verdicts.length}</span>}>
      {verdicts.length ? <div className="symbol-events">{verdicts.map((verdict) => <article key={verdict.id} className="symbol-event"><div className="symbol-event-heading"><StatusBadge state={verdict.kind.toUpperCase()} /><time>{at(verdict.occurredAt)}</time></div><p className="mt-2 text-meta text-muted break-words">{(verdict.conditionsMetJson as string[]).join(", ").replace(/_/g, " ")}</p><div className="mt-3"><Evidence entries={evidenceFrom(verdict.evidenceJson as Record<string, unknown>, security.currency)} /></div></article>)}</div> : <EmptyState title="No thesis verdicts yet" description={thesis ? "Your saved condition has no recorded trigger or contradiction. Its current state is shown above." : "Add a structured thesis to monitor the reason you’re watching."} icon="shield" />}
    </DashboardCard></div>
  </AppShell>;
}
