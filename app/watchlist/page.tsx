import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { AddSymbolForm } from "./add-symbol-form";
import { WatchlistTable } from "./watchlist-table";
import { AppShell } from "@/components/app-shell";

// Quotes are read per request; caching would defeat the freshness guarantee.
export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const rows = await getWatchlist(user.id);

  return (
    <AppShell email={user.email} active="watchlist">
      <section className="mt-8">
        <h1 className="text-title font-medium tracking-tight">Watchlist</h1>
        <p className="mt-1 text-meta text-muted">Prices are last-known-good and always carry their exchange time.</p>
      </section>

      <div className="mt-6" id="add-stock">
        <AddSymbolForm />
      </div>

      <div className="mt-8">
        <WatchlistTable rows={rows} />
      </div>
    </AppShell>
  );
}
