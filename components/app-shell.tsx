import { signOut } from "@/app/actions";
import { AskThesisPanel } from "@/components/ask-thesis-drawer";
import { AppSidebar, GlobalSearch, MenuButton, WorkspaceProvider } from "@/components/workspace-controls";
import { Icon, feedDisplay } from "@/components/ui";
import { formatIST } from "@/lib/time";
import type { WatchlistRow } from "@/lib/watchlist";

type AppShellProps = { email: string; active: "home" | "digest" | "watchlist"; currentSymbol?: string; rows: WatchlistRow[]; demo?: boolean; overview?: React.ReactNode; children: React.ReactNode };

export function AppShell({ email, active, currentSymbol, rows, demo = false, overview, children }: AppShellProps) {
  // Oldest watched quote is aggregate freshness, so a single recent quote
  // cannot make an otherwise stale watchlist look current.
  const oldest = rows.some((row) => !row.asOf) ? null : [...rows].sort((a, b) => (a.asOf?.getTime() ?? 0) - (b.asOf?.getTime() ?? 0))[0];
  const health = rows.some((row) => row.health === "unresolved") ? "unresolved" : rows.some((row) => row.health === "degraded") ? "degraded" : "ok";
  const feed = feedDisplay(oldest?.asOf ?? null, oldest?.marketState ?? null, health, demo);
  return <WorkspaceProvider><div className="terminal">
    <AppSidebar active={active} logout={<form action={signOut}><button className="sidebar-link logout-button" aria-label="Sign out"><Icon name="logout" /><span>Logout</span></button></form>} />
    <div className="terminal-workspace">
      <header className="top-bar"><MenuButton /><GlobalSearch watched={rows.map((row) => row.symbol)} />
        <div className="top-feed"><span className={`feed-dot ${feed.tone}`} /><div><strong>{feed.label}</strong><small>{feed.asOf ? `${formatIST(feed.asOf)} IST · exchange time` : "NSE · quotes shown when available"}</small></div></div>
        <div className="user-identity"><span className="user-avatar" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span><span title={email}>{email}</span></div>
      </header>
      <div className={`workspace-content ${overview ? "has-overview" : ""}`}>{overview}<div className="workspace-grid"><div className="workspace-main">{children}</div><AskThesisPanel key={currentSymbol ?? "watchlist"} currentSymbol={currentSymbol} demo={demo} /></div></div>
      <footer className="terminal-footer"><span>THESIS is an attention tool, not an advisory product. It reports changes to conditions you defined.</span><span>Market data is delayed · exchange times in IST</span></footer>
    </div>
  </div></WorkspaceProvider>;
}
