import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { getPresentationData } from "@/lib/presentation";
import { WatchlistTable } from "./watchlist-table";
import { AppShell } from "@/components/app-shell";
import { DashboardCard } from "@/components/ui";
import { AddStockButton } from "@/components/workspace-controls";
import { ThesisOverview, ThesisCard } from "@/components/dashboard-widgets";

export const dynamic = "force-dynamic";
export default async function WatchlistPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const [rows, presentation] = await Promise.all([getWatchlist(user.id), getPresentationData(user.id)]);
  return <AppShell email={user.email} active="watchlist" rows={rows} demo={presentation.demo}>
    <div className="page-heading"><div><p className="eyebrow">YOUR IDEAS, IN FOCUS</p><h1>Watchlist</h1><p>The companies you follow. The reasons you keep watching.</p></div><AddStockButton /></div>
    <DashboardCard title="My Watchlist" meta={<span className="count-chip">{rows.length}</span>} action={<span className="eyebrow">NSE · INR</span>}><WatchlistTable rows={rows} demo={presentation.demo} /></DashboardCard>
    <div className="two-column mt-4"><ThesisOverview theses={presentation.theses} /><DashboardCard title="Keep the reason in view"><div className="panel-body text-muted leading-relaxed"><p>A watchlist gets more useful when it remembers what you’re waiting for.</p><p className="mt-2">Choose an optional price range, breakout level, or monitoring condition when you add a company.</p><p className="mt-3 text-meta text-faint">Every quote carries its exchange time. Failed updates preserve the last-known price.</p></div></DashboardCard></div>
    {presentation.theses.length > 0 && <><div className="section-heading"><h2>Your recorded theses</h2><span>Displayed exactly as recorded</span></div><div className="two-column">{presentation.theses.map((thesis) => <ThesisCard key={thesis.id} thesis={thesis} company={rows.find((row) => row.symbol === thesis.symbol)?.name} />)}</div></>}
  </AppShell>;
}
