import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { theses, watchlistItems } from "@/db/schema";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { getCompanyView } from "@/lib/company";
import type { StoredThesis } from "@/lib/presentation";
import { Evidence } from "@/components/evidence";
import { formatExchangeTime } from "@/lib/time";
import { formatCount, marketLine } from "@/lib/securities";
import { indexDisplayName } from "@/lib/market-brief";
import { acknowledge } from "@/app/actions";
import { AppShell } from "@/components/app-shell";
import { DashboardCard, EmptyState, Icon, CompanyMark, formatPrice, FreshnessBadge, PriceChange, StatusBadge } from "@/components/ui";
import { ThesisCard } from "@/components/dashboard-widgets";
import { SymbolChart } from "@/components/symbol-chart";
import { PriceHistorySection, PriceHistorySkeleton, MarketDataSection, MarketDataSkeleton } from "@/components/company-sections";
import { AddToWatchlistButton } from "@/components/workspace-controls";
import { MarketPattern } from "@/components/market-pattern";
import {
  MarketPatternSection, MarketPatternSkeleton, SymbolEventsSection, SymbolEventsSkeleton,
  ThesisReplaySection, ThesisReplaySkeleton,
} from "@/components/symbol-sections";
import { traceRoute, traced } from "@/lib/trace";

/**
 * Company detail — for any supported security, watched or not.
 *
 * Search is discovery, so this page must answer "what is this company doing"
 * before anyone commits to watching it. Market information is shown for every
 * security the provider resolves; the thesis surfaces — condition, verdicts,
 * evidence, replay — appear only when this user actually watches it, because a
 * thesis is a fact about them and inventing one for a stranger's page would be
 * exactly the fabrication this product exists to avoid.
 */
export const dynamic = "force-dynamic";
export default async function SymbolPage({ params }: { params: Promise<{ symbol: string }> }) {
  const done = traceRoute("symbol");
  const user = await traced("symbol:session", () => getSessionUser());
  if (!user) redirect("/login");
  const { symbol: raw } = await params;
  const company = await traced("symbol:companyView", () => getCompanyView(user.id, decodeURIComponent(raw)));
  if (!company) notFound();
  const { symbol, security, quote, stats } = company;

  // Everything the visible top of the page needs, in one round trip. The event
  // history, the replay and the anomaly classification stream in behind their
  // own boundaries — see components/symbol-sections.tsx.
  const [items, rows] = await Promise.all([
    traced("symbol:thesis", () => company.watched
      ? db.select({
          itemId: watchlistItems.id, thesisId: theses.id, thesisType: theses.type, thesisNote: theses.note,
          thesisState: theses.state, thesisCreatedAt: theses.createdAt, paramsAdjustedAt: theses.paramsAdjustedAt,
          thesisParams: theses.paramsJson,
        })
        .from(watchlistItems).leftJoin(theses, eq(theses.watchlistItemId, watchlistItems.id))
        .where(eq(watchlistItems.id, company.watchlistItemId!)).limit(1)
      : Promise.resolve([])),
    traced("symbol:watchlist", () => getWatchlist(user.id)),
  ]);
  done();
  const item = items[0];

  const money = (value: number | null) => formatPrice(value, security.currency);
  const at = (value: Date) => formatExchangeTime(value, security.timeZone);
  const storedParams = (item?.thesisParams ?? {}) as Record<string, unknown>;
  const adjustments = (Array.isArray(storedParams.adjustments) ? storedParams.adjustments : []) as { reason: string; factor: number; affectedFrom: string; affectedTo: string; before: Record<string, number>; after: Record<string, number> }[];
  const thesis: StoredThesis | undefined = item?.thesisId && item.thesisCreatedAt
    ? { id: item.thesisId, symbol, type: item.thesisType ?? "none", state: item.thesisState ?? "WATCHING", params: item.thesisParams, note: item.thesisNote, createdAt: item.thesisCreatedAt }
    : undefined;
  const demo = process.env.THESIS_DATA_MODE === "demo";

  // The session panel shows only what the source actually gave us: stored bars
  // carry no high or low, so those rows are absent rather than guessed.
  const bar = company.latestBar;
  const sessionRows = [
    { label: "Open", value: bar?.open != null ? money(bar.open) : null },
    { label: "High", value: bar?.high != null ? money(bar.high) : null },
    { label: "Low", value: bar?.low != null ? money(bar.low) : null },
    { label: "Previous close", value: quote.previousClose != null ? money(quote.previousClose) : null },
    { label: "Volume", value: bar?.volume != null ? formatCount(bar.volume, security.currency) : null },
    { label: "Median volume", value: stats?.medianVolume20 != null ? formatCount(stats.medianVolume20, security.currency) : null, basis: "20 sessions" },
    { label: "Realized volatility", value: stats?.realizedVol20 != null ? `${(stats.realizedVol20 * 100).toFixed(2)}%` : null, basis: "daily, 20-day" },
    { label: "20-day average", value: stats?.ma20 != null ? money(stats.ma20) : null },
  ].flatMap((row) => row.value ? [{ label: row.label, value: row.value, basis: row.basis }] : []);

  return <AppShell email={user.email} displayName={user.displayName} active={company.watched ? "watchlist" : "home"} currentSymbol={company.watched ? symbol : undefined} rows={rows} demo={demo}>
    <div className="symbol-toolbar">
      <Link href={company.watched ? "/watchlist" : "/"} className="inline-flex gap-2 items-center text-meta text-faint hover:text-accent"><span>←</span> {company.watched ? "Back to watchlist" : "Back to market brief"}</Link>
      <div className="symbol-actions">
        {company.watched
          ? <span className="status-badge positive"><Icon name="watchlist" size={13} /> In watchlist</span>
          : <AddToWatchlistButton symbol={symbol} />}
        {company.watched && <Link className="button-secondary" href={`/ask?symbol=${encodeURIComponent(symbol)}`}><Icon name="chat" size={15} />Ask THESIS about this stock</Link>}
      </div>
    </div>

    <header className="symbol-heading">
      <div className="flex items-center gap-3 min-w-0"><CompanyMark symbol={symbol} /><div className="min-w-0">
        <h1>{company.name ?? symbol}</h1>
        <p className="text-meta text-faint mt-1">{symbol}{marketLine(security) && <> <span className="mx-1">·</span> {marketLine(security)}</>}{security.currency && <> <span className="mx-1">·</span> {security.currency}</>}</p>
      </div></div>
      <div className="symbol-price">
        <div className="num text-title">{money(quote.price)}</div>
        <div><PriceChange value={quote.changePercent} /><span className="text-micro text-faint ml-2">vs prev close</span></div>
        <FreshnessBadge asOf={quote.asOf} marketState={quote.marketState} health={company.health} demo={demo} timeZone={security.timeZone} />
        <p className="text-micro text-faint mt-1">{quote.asOf ? at(quote.asOf) : "No quote received yet"}</p>
      </div>
    </header>

    <div className="symbol-grid">
      {company.historySource === "stored"
        ? <DashboardCard title="Price History" action={<span className="status-badge neutral">OBSERVED</span>}>
            <SymbolChart daily={company.daily} intraday={company.intraday} exchange={security.exchange} timeZone={security.timeZone} source="stored" />
          </DashboardCard>
        // Nothing is watched here yet, so the bars come from the provider. That
        // request streams rather than holding up the whole page.
        : <Suspense fallback={<PriceHistorySkeleton />}>
            <PriceHistorySection symbol={symbol} intraday={company.intraday} exchange={security.exchange} timeZone={security.timeZone} />
          </Suspense>}
      {company.watched
        ? <ThesisCard thesis={thesis} company={company.name} currency={security.currency} timeZone={security.timeZone}>
            {item?.paramsAdjustedAt && adjustments.map((a, i) => <div className="adjustment-note" key={i}><strong>Adjusted for a corporate action</strong><p className="mt-1">{a.reason} · {a.factor}× · {a.affectedFrom} to {a.affectedTo}</p>{Object.keys(a.before).map((key) => <p key={key}>{key}: <s>{money(a.before[key])}</s> → {money(a.after[key])}</p>)}</div>)}
            {item?.thesisId && <form action={acknowledge} className="mt-4"><input type="hidden" name="thesisId" value={item.thesisId} /><button className="button-secondary">Keep watching</button></form>}
          </ThesisCard>
        : <DashboardCard title="My Thesis" action={<span className="status-badge neutral">NOT WATCHED</span>} className="thesis-card">
            <div className="panel-body"><EmptyState
              title="Add this company to your watchlist to define why you’re watching it."
              description="THESIS monitors the reason you gave, not just the price. Nothing personal is recorded for a company you do not watch — no condition, no status, no evidence."
              icon="watchlist"><AddToWatchlistButton symbol={symbol} label="Add to Watchlist" /></EmptyState></div>
          </DashboardCard>}
    </div>

    {/* Secondary evidence, and placed after the thesis surfaces for that reason. */}
    {company.historySource === "stored"
      ? <Suspense fallback={<MarketPatternSkeleton />}><MarketPatternSection symbol={symbol} timeZone={security.timeZone} /></Suspense>
      // Not monitored: there is nothing to classify and no read to make.
      : <MarketPattern anomaly={null} timeZone={security.timeZone} monitored={false} />}

    {company.watched && <Suspense fallback={<ThesisReplaySkeleton />}>
      <ThesisReplaySection userId={user.id} symbol={symbol} demo={demo} exchange={security.exchange} />
    </Suspense>}

    <div className="two-column mt-4">
      {company.historySource === "stored"
        ? <DashboardCard title="Market Data" action={<span className="eyebrow">{company.latestBar ? `SESSION ${company.latestBar.date}` : "LATEST QUOTE"}</span>}>
            {sessionRows.length
              ? <div className="panel-body"><Evidence entries={sessionRows} /></div>
              : <EmptyState title="No session data available yet" description="Open, volume and reference levels appear once usable history has been observed for this company." />}
          </DashboardCard>
        : <Suspense fallback={<MarketDataSkeleton />}>
            <MarketDataSection symbol={symbol} currency={security.currency} previousClose={quote.previousClose} stats={stats} />
          </Suspense>}
      <DashboardCard title="Reference Levels" action={<span className="eyebrow">ADJUSTED SERIES</span>}>
        {stats ? <><div className="panel-body"><Evidence entries={[
          { label: "52-week high", value: money(stats.high52w), basis: "adjusted closes" },
          { label: "52-week low", value: money(stats.low52w), basis: "adjusted closes" },
          { label: "20-day high / low", value: `${money(stats.high20)} / ${money(stats.low20)}`, basis: "adjusted closes" },
          // Beta is measured against this security's own market index, and says so
          // — or says it is unavailable, rather than borrowing another market's.
          // The index by name here too, so one page never mixes "NIFTY 50" with "^NSEI".
          { label: "Beta", value: stats.beta60 == null ? "—" : stats.beta60.toFixed(2),
            basis: stats.beta60 == null
              ? security.benchmark ? `no ${indexDisplayName(security.benchmark)} history stored yet` : "no benchmark for this market"
              : `60-day, vs ${security.benchmark ? indexDisplayName(security.benchmark) : "benchmark"}` },
          { label: "Sessions held", value: String(stats.sessionsUsed), basis: "traded sessions only" },
        ]} /></div><p className="panel-caption">Computed {at(stats.computedAt)}</p></>
          : <EmptyState title="Reference statistics are not available yet" description={company.watched
              ? "Statistics will appear after sufficient usable history has been ingested."
              : "THESIS computes statistics for the companies it monitors. Add this one to your watchlist to have them recorded."} />}
      </DashboardCard>
    </div>

    <Suspense fallback={<SymbolEventsSkeleton />}>
      <SymbolEventsSection
        userId={user.id}
        symbol={symbol}
        watched={company.watched}
        currency={security.currency}
        timeZone={security.timeZone}
        company={company.name ?? symbol}
        sessionsUsed={stats?.sessionsUsed ?? 0}
        hasThesis={thesis != null} />
    </Suspense>
  </AppShell>;
}
