import { signOut } from "@/app/actions";
import { AccountMenu } from "@/components/account-menu";
import { AppSidebar, GlobalSearch, MenuButton, WorkspaceProvider } from "@/components/workspace-controls";
import { Icon, watchlistFeed } from "@/components/ui";
import { formatExchangeTime } from "@/lib/time";
import type { WatchlistRow } from "@/lib/watchlist";

type AppShellProps = { email: string; displayName: string | null; active: "home" | "digest" | "watchlist" | "ask"; currentSymbol?: string; rows: WatchlistRow[]; demo?: boolean; children: React.ReactNode };

export function AppShell({ email, displayName, active, currentSymbol, rows, demo = false, children }: AppShellProps) {
  // Oldest watched quote is aggregate freshness, so a single recent quote
  // cannot make an otherwise stale watchlist look current.
  const feed = watchlistFeed(rows, demo);
  return <WorkspaceProvider><div className="terminal">
    <AppSidebar active={active} currentSymbol={currentSymbol} />
    <div className="terminal-workspace">
      <header className="top-bar"><MenuButton /><GlobalSearch watched={rows.map((row) => row.symbol)} />
        {/* Oldest watched quote, on ITS OWN exchange clock. A mixed-market
            watchlist never claims a single session state — see watchlistFeed. */}
        <div className="top-feed"><span className={`feed-dot ${feed.tone}`} /><div><strong>{feed.label}</strong><small>{feed.asOf ? `${formatExchangeTime(feed.asOf, feed.timeZone)} · exchange time` : "quotes shown when available"}</small></div></div>
        <AccountMenu name={displayName} email={email} logout={<form action={signOut}><button className="button-secondary"><Icon name="logout" />Sign out</button></form>} />
      </header>
      <div className={`workspace-content page-${active}`}><div className="workspace-main">{children}</div></div>
      <footer className="terminal-footer"><span>THESIS is an attention tool, not an advisory product. It reports changes to conditions you defined.</span><span>Market data is delayed · every time is shown on its own exchange’s clock</span></footer>
    </div>
  </div></WorkspaceProvider>;
}
