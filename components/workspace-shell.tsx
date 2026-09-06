"use client";
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/account-menu";
import { AppSidebar, GlobalSearch, MenuButton, WorkspaceProvider } from "@/components/workspace-controls";

export type WorkspaceSnapshot = {
  email: string; displayName: string | null; active: "home" | "digest" | "watchlist" | "ask";
  currentSymbol?: string; watched: string[];
  feed: { label: string; tone: string; timestamp: string };
};
const SnapshotContext = createContext<((snapshot: WorkspaceSnapshot) => void) | null>(null);

/** Fresh, authenticated page data updates the persistent chrome, never a global cache. */
export function WorkspaceSnapshot({ snapshot, children }: { snapshot: WorkspaceSnapshot; children: ReactNode }) {
  const update = useContext(SnapshotContext);
  useLayoutEffect(() => { update?.(snapshot); }, [snapshot, update]);
  return children;
}

/** Layout survives sibling navigation: search/account/navigation stay interactive. */
export function WorkspaceShell({ initial, logout, children }: { initial: WorkspaceSnapshot; logout: ReactNode; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(initial);
  const pathname = usePathname();
  const symbol = pathname.startsWith("/symbol/") ? decodeURIComponent(pathname.slice(8)) : undefined;
  const active = pathname === "/ask" ? "ask" : pathname === "/digest" ? "digest"
    : pathname === "/watchlist" || (symbol && snapshot.watched.includes(symbol)) ? "watchlist" : "home";
  const currentSymbol = symbol && snapshot.watched.includes(symbol) ? symbol : active === "ask" ? snapshot.currentSymbol : undefined;
  return <SnapshotContext.Provider value={setSnapshot}><WorkspaceProvider><div className="terminal">
    <AppSidebar active={active} currentSymbol={currentSymbol} />
    <div className="terminal-workspace">
      <header className="top-bar"><MenuButton /><GlobalSearch watched={snapshot.watched} />
        <div className="top-feed"><span className={`feed-dot ${snapshot.feed.tone}`} /><div><strong>{snapshot.feed.label}</strong><small>{snapshot.feed.timestamp}</small></div></div>
        <AccountMenu name={snapshot.displayName} email={snapshot.email} logout={logout} />
      </header>
      <div className={`workspace-content page-${active}`}><div className="workspace-main">{children}</div></div>
      <footer className="terminal-footer"><span>THESIS is an attention tool, not an advisory product. It reports changes to conditions you defined.</span><span>Market data is delayed · every time is shown on its own exchange’s clock</span></footer>
    </div>
  </div></WorkspaceProvider></SnapshotContext.Provider>;
}
