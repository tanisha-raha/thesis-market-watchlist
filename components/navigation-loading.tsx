"use client";
import { usePathname } from "next/navigation";

/** Prefetchable, non-personal destination UI. Never a fake quote/evidence snapshot. */
export function NavigationLoading() {
  const path = usePathname();
  const title = path === "/watchlist" ? "Watchlist" : path === "/digest" ? "While you were away"
    : path === "/ask" ? "Ask THESIS" : path.startsWith("/symbol/") ? decodeURIComponent(path.slice(8)) : "Market Brief";
  return <section data-navigation-loading role="status" aria-live="polite" aria-busy="true">
    <div className="page-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>{title}</h1><p>Loading your latest stored view…</p></div></div>
    <div className="panel"><p className="text-meta text-faint">Your navigation and account controls remain available.</p></div>
  </section>;
}
