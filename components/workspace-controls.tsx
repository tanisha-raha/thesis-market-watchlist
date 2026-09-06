"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AddSymbolForm } from "@/app/watchlist/add-symbol-form";
import { Modal } from "@/components/modal";
import { BrandMark, Icon } from "@/components/ui";
import type { SearchResult } from "@/lib/market/types";

type Controls = { openAdd: (symbol?: string) => void; menuOpen: boolean; setMenuOpen: (open: boolean) => void };
const WorkspaceContext = createContext<Controls | null>(null);
export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace controls require the authenticated shell");
  return value;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [add, setAdd] = useState<{ symbol: string } | null>(null);
  const openAdd = useCallback((symbol = "") => setAdd({ symbol }), []);
  const closeAdd = useCallback(() => {
    setAdd(null);
    if (window.location.hash.startsWith("#add-stock")) history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  // `#add-stock` / `#add-stock:SYMBOL` still opens the dialog, so a link into the
  // add flow keeps working. Search no longer uses it: selecting a company now
  // opens that company's page, and adding starts from there or from the
  // watchlist's own button.
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash;
      if (window.location.pathname !== "/watchlist") return;
      if (hash === "#add-stock") openAdd();
      else if (hash.startsWith("#add-stock:")) openAdd(decodeURIComponent(hash.slice(11)));
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [openAdd, pathname]);
  return <WorkspaceContext.Provider value={{ openAdd, menuOpen, setMenuOpen }}>
    {children}
    <Modal open={add !== null} onClose={closeAdd} label="Add stock" className="add-dialog">
      <div className="dialog-surface">
        <header className="panel-heading"><div><span className="eyebrow">Your next idea</span><h2 className="mt-1">Add to your watchlist</h2></div><button type="button" className="icon-button" aria-label="Close Add Stock" onClick={closeAdd}><Icon name="close" /></button></header>
        {add && <AddSymbolForm key={add.symbol} initialSymbol={add.symbol} onAdded={closeAdd} />}
      </div>
    </Modal>
  </WorkspaceContext.Provider>;
}
export function AddStockButton({ label = "Add Stock", compact = false }: { label?: string; compact?: boolean }) {
  const { openAdd } = useWorkspace();
  return <button type="button" onClick={() => openAdd()} className={`button-primary ${compact ? "compact" : ""}`}><Icon name="plus" size={15} />{label}</button>;
}
/**
 * Start watching the company being looked at.
 *
 * Deliberately the SAME dialog the watchlist uses — symbol, optional structured
 * condition, optional note — rather than a second add path that would drift out
 * of step with it.
 */
export function AddToWatchlistButton({ symbol, label = "Add to Watchlist" }: { symbol: string; label?: string }) {
  const { openAdd } = useWorkspace();
  return <button type="button" onClick={() => openAdd(symbol)} className="button-primary"><Icon name="plus" size={15} />{label}</button>;
}
export function AppSidebar({ active, currentSymbol }: { active: "home" | "watchlist" | "digest" | "ask"; currentSymbol?: string }) {
  const { menuOpen, setMenuOpen } = useWorkspace();
  return <>
    {menuOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`app-sidebar ${menuOpen ? "is-open" : ""}`}>
      <Link href="/" className="brand" aria-label="THESIS home" onClick={() => setMenuOpen(false)}><BrandMark /><div><strong>THESIS</strong><small>Track. Think. Invest Smarter.</small></div></Link>
      <div className="sidebar-section-label">YOUR WORKSPACE</div>
      <nav aria-label="Main navigation">
        {([{ key: "home", href: "/", label: "Home" }, { key: "watchlist", href: "/watchlist", label: "Watchlist" }, { key: "digest", href: "/digest", label: "Digest" }] as const).map((item) => <Link key={item.key} href={item.href} className={`sidebar-link ${active === item.key ? "active" : ""}`} aria-current={active === item.key ? "page" : undefined} onClick={() => setMenuOpen(false)}><Icon name={item.key} /><span>{item.label}</span>{active === item.key && <span className="nav-active-dot" />}</Link>)}
        <Link href={currentSymbol ? `/ask?symbol=${encodeURIComponent(currentSymbol)}` : "/ask"} className={`sidebar-link ask-nav ${active === "ask" ? "active" : ""}`} aria-current={active === "ask" ? "page" : undefined} onClick={() => setMenuOpen(false)}><Icon name="chat" /><span>Ask THESIS</span>{active === "ask" && <span className="nav-active-dot" />}</Link>
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-quote"><span className="eyebrow">KEEP YOUR PERSPECTIVE</span><p>A watchlist that remembers why you’re watching.</p><span className="short-rule" /></div></div>
    </aside>
  </>;
}
export function MenuButton() {
  const { setMenuOpen, menuOpen } = useWorkspace();
  return <button type="button" className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button>;
}
export function GlobalSearch({ watched }: { watched: string[] }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [state, setState] = useState("idle");
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /**
   * Search is discovery, not an add shortcut.
   *
   * Selecting a company opens its detail page — watched or not — so a user can
   * look at what it is doing before deciding whether the reason to watch it is
   * worth writing down. Adding still happens through the watchlist's own flow,
   * from the button on that page.
   */
  const select = () => {
    setExpanded(false); setQuery("");
  };
  useEffect(() => {
    const shortcut = (e: KeyboardEvent) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) { e.preventDefault(); input.current?.focus(); }
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setState("idle"); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setState("loading");
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const data: SearchResult[] = await response.json();
        setResults(data.slice(0, 8)); setState("ready");
      } catch { if (!controller.signal.aborted) setState("error"); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);
  return <div className="global-search" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}>
    <Icon name="search" size={19} /><input ref={input} aria-label="Search companies" value={query} onFocus={() => setExpanded(true)} onChange={(e) => { setQuery(e.target.value); setExpanded(true); }} placeholder="Search for a company (e.g. Infosys, Reliance, Apple...)" autoComplete="off" /><kbd>/</kbd>
    {expanded && query.trim().length >= 2 && <div className="search-results">
      <div className="eyebrow px-3 py-2">COMPANIES</div>
      {state === "loading" && <p role="status">Searching…</p>}
      {state === "error" && <p role="alert">Search is unavailable. Try again shortly.</p>}
      {state === "ready" && results.length === 0 && <p>No supported companies found.</p>}
      {results.map((result) => <Link key={result.symbol} href={`/symbol/${encodeURIComponent(result.symbol)}`} onClick={select}>
        <span className="search-company"><strong>{result.name ?? result.symbol}</strong><small><span className="num">{result.symbol}</span>{result.exchange ? ` · ${[result.exchange, result.market].filter(Boolean).join(" · ")}` : ""}</small></span>
        <span className="text-accent text-meta">{watched.includes(result.symbol) ? "Watching" : "View"}<Icon name="arrow" size={13} /></span>
      </Link>)}
    </div>}
  </div>;
}
