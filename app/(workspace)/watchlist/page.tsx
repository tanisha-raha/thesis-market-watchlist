import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { getPresentationData } from "@/lib/presentation";
import { getThesisHealth } from "@/lib/notifications";
import { WatchlistTable } from "@/app/watchlist/watchlist-table";
import { AppShell } from "@/components/app-shell";
import { DashboardCard } from "@/components/ui";
import { AddStockButton } from "@/components/workspace-controls";
import { thesisCondition } from "@/lib/thesis-display";
import { traceRoute, traced } from "@/lib/trace";

export const dynamic = "force-dynamic";
export default async function WatchlistPage() {
  const done = traceRoute("watchlist");
  const user = await traced("watchlist:session", () => getSessionUser());
  if (!user) redirect("/login");
  const [rows, presentation, health] = await Promise.all([
    traced("watchlist:watchlist", () => getWatchlist(user.id)),
    traced("watchlist:presentation", () => getPresentationData(user.id)),
    traced("watchlist:health", () => getThesisHealth(user.id)),
  ]);
  done();
  const currencyFor = new Map(rows.map((row) => [row.symbol, row.security.currency]));
  const conditions = Object.fromEntries(presentation.theses.map((t) => [t.symbol, thesisCondition(t.type, t.params, currencyFor.get(t.symbol) ?? null)]));
  // A watchlist can hold several markets at once. Say which, rather than
  // stamping one exchange and one currency across all of them.
  const markets = [...new Set(rows.map((row) => row.security.marketLabel).filter((m): m is string => m != null))];
  return <AppShell email={user.email} displayName={user.displayName} active="watchlist" rows={rows} demo={presentation.demo}>
    <div className="page-heading"><div><p className="eyebrow">YOUR IDEAS, IN FOCUS</p><h1>Watchlist</h1><p>The companies you follow and why.</p></div><AddStockButton /></div>
    <DashboardCard title="My Watchlist" meta={<span className="count-chip">{rows.length}</span>} action={<span className="eyebrow">{markets.length ? `${markets.join(" · ")} · NATIVE CURRENCY` : "NATIVE CURRENCY"}</span>}><WatchlistTable rows={rows} conditions={conditions} demo={presentation.demo} health={Object.fromEntries([...health].map(([symbol, view]) => [symbol, view.health]))} /></DashboardCard>
    <p className="page-note">Every price is shown in the company’s own trading currency and every timestamp on its own exchange’s clock — values are never converted or combined across markets. Open a company to see its full thesis, original note and recorded evidence. Prices remain last-known-good when a feed update fails.</p>
  </AppShell>;
}
