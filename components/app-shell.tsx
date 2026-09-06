import { signOut } from "@/app/actions";
import { WorkspaceShell, WorkspaceSnapshot } from "@/components/workspace-shell";
import { Icon, watchlistFeed } from "@/components/ui";
import { formatExchangeTime } from "@/lib/time";
import type { WatchlistRow } from "@/lib/watchlist";

type AppShellProps = { email: string; displayName: string | null; active: "home" | "digest" | "watchlist" | "ask"; currentSymbol?: string; rows: WatchlistRow[]; demo?: boolean; children: React.ReactNode };

function snapshotFor({ email, displayName, active, currentSymbol, rows, demo = false }: AppShellProps) {
  // Oldest watched quote is aggregate freshness, so a single recent quote
  // cannot make an otherwise stale watchlist look current.
  const feed = watchlistFeed(rows, demo);
  return { email, displayName, active, currentSymbol, watched: rows.map((row) => row.symbol),
    feed: { label: feed.label, tone: feed.tone, timestamp: feed.asOf ? `${formatExchangeTime(feed.asOf, feed.timeZone)} · exchange time` : "quotes shown when available" } };
}

/** Pages publish their fresh snapshot, but no longer remount the whole shell. */
export function AppShell(props: AppShellProps) {
  return <WorkspaceSnapshot snapshot={snapshotFor(props)}>{props.children}</WorkspaceSnapshot>;
}

export function AuthenticatedShell(props: AppShellProps & { userId: number }) {
  return <WorkspaceShell key={props.userId} initial={snapshotFor(props)} logout={<form action={signOut}><button className="button-secondary"><Icon name="logout" />Sign out</button></form>}>
    {props.children}
  </WorkspaceShell>;
}
