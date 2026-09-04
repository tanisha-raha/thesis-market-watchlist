import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { signOut } from "@/app/actions";
import { AddSymbolForm } from "./add-symbol-form";
import { WatchlistTable } from "./watchlist-table";

// Quotes are read per request; caching would defeat the freshness guarantee.
export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const rows = await getWatchlist(user.id);

  return (
    <div>
      <header className="flex items-baseline justify-between border-b border-line pb-4">
        <div>
          <h1 className="text-section font-medium tracking-tight">Watchlist</h1>
          <p className="mt-0.5 text-meta text-faint">{user.email}</p>
        </div>
        <form action={signOut}>
          <button className="text-meta text-muted transition-colors hover:text-ink">
            Sign out
          </button>
        </form>
      </header>

      <div className="mt-6">
        <AddSymbolForm />
      </div>

      <div className="mt-8">
        <WatchlistTable rows={rows} />
      </div>
    </div>
  );
}
