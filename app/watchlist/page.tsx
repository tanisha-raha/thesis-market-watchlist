import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getWatchlist } from "@/lib/watchlist";
import { signOut } from "@/app/actions";
import { AddSymbolForm } from "./add-symbol-form";
import { WatchlistTable } from "./watchlist-table";

// Quotes are fetched per request; caching the page would defeat the freshness
// guarantee the UI makes.
export const dynamic = "force-dynamic";

export default async function WatchlistPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const rows = await getWatchlist(user.id);

  return (
    <div>
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Watchlist</h1>
          <p className="mt-1 text-sm text-[--color-muted]">{user.email}</p>
        </div>
        <form action={signOut}>
          <button className="text-sm text-[--color-muted] hover:text-[--color-ink]">Sign out</button>
        </form>
      </header>

      <div className="mt-8">
        <AddSymbolForm />
      </div>

      <div className="mt-8">
        <WatchlistTable rows={rows} />
      </div>
    </div>
  );
}
