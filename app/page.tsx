import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { getDigest } from "@/lib/digest";
import { getPresentationData, getStoredHistory, getStoredEvidence } from "@/lib/presentation";
import { AppShell } from "@/components/app-shell";
import { HeroPanel, SummaryMetrics, DigestPreview, ThesisOverview, ThesisCard, FeaturedStock, EvidencePanel } from "@/components/dashboard-widgets";
import { DashboardCard, Icon } from "@/components/ui";
import { AddStockButton } from "@/components/workspace-controls";
import { WatchlistTable } from "@/app/watchlist/watchlist-table";

export const dynamic = "force-dynamic";
export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const [rows, d, presentation] = await Promise.all([getWatchlist(user.id), getDigest(user.id), getPresentationData(user.id)]);
  const thesis = presentation.theses.find((item) => item.type !== "none") ?? presentation.theses[0];
  const featured = rows.find((row) => row.symbol === thesis?.symbol) ?? rows[0];
  const [points, evidence] = featured ? await Promise.all([getStoredHistory(featured.symbol), getStoredEvidence(user.id, featured.symbol)]) : [[], { entries: [], occurredAt: null }];
  return <AppShell email={user.email} active="home" rows={rows} demo={presentation.demo} overview={<><HeroPanel /><SummaryMetrics rows={rows} d={d} theses={presentation.theses} benchmark={presentation.benchmark} demo={presentation.demo} /></>}>
    <div className={`home-grid ${!rows.length ? "is-empty" : ""}`}><div className="home-watchlist-column"><DashboardCard title="My Watchlist" meta={<span className="count-chip">{rows.length}</span>} action={<AddStockButton compact />} className="home-watchlist"><WatchlistTable rows={rows} demo={presentation.demo} /><p className="panel-caption">Prices are last-known-good · changes vs previous close</p></DashboardCard>{!rows.length && <DashboardCard title="A watchlist with a reason" className="mt-4"><div className="getting-started"><div><Icon name="watchlist" /><span><strong>Choose a company</strong><small>Start with a stock you already follow.</small></span></div><div><Icon name="shield" /><span><strong>Record your perspective</strong><small>Add a condition and an optional note.</small></span></div><div><Icon name="activity" /><span><strong>Return to the evidence</strong><small>See what changed while you were away.</small></span></div></div></DashboardCard>}</div><div className="home-insights"><DigestPreview d={d} /><ThesisOverview theses={presentation.theses} /></div></div>
    {featured && <div className="featured-grid"><FeaturedStock row={featured} points={points} demo={presentation.demo} /><div className="featured-context"><ThesisCard thesis={thesis} company={featured.name} /><EvidencePanel entries={evidence.entries.slice(0, 5)} occurredAt={evidence.occurredAt} state={thesis?.state} href={`/symbol/${encodeURIComponent(featured.symbol)}#evidence`} /></div></div>}
  </AppShell>;
}
