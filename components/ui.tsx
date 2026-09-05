import type { ReactNode } from "react";
import { formatAge, formatExchangeTime } from "@/lib/time";
import { IST } from "@/lib/time";
import { formatMoney } from "@/lib/securities";
import type { WatchlistRow } from "@/lib/watchlist";

export type IconName = "home" | "watchlist" | "digest" | "chat" | "search" | "plus" | "arrow" | "logout" | "close" | "menu" | "activity" | "shield" | "chevron" | "send" | "sun" | "moon";
const paths: Record<IconName, ReactNode> = {
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  moon: <path d="M20.5 13.5A9 9 0 0 1 10.5 3 9 9 0 1 0 20.5 13.5Z" />,
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" /></>,
  watchlist: <><path d="M6 3h12v18l-6-4-6 4Z" /><path d="M9 7h6M9 10h4" /></>,
  digest: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 7h1m3 0h4M8 12h1m3 0h4M8 17h1m3 0h4" /></>,
  chat: <><path d="M21 11a9 8 0 0 1-9 8H8l-5 3 1-7a8 8 0 0 1-1-4 9 8 0 0 1 18 0Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  logout: <><path d="M9 4H4v16h5m5-14 6 6-6 6M8 12h12" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  send: <><path d="m3 10 18-7-7 18-3-8-8-3Zm8 3L21 3" /></>,
};
export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 ${className}`}>{paths[name]}</svg>;
}
export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>;
}
export function DashboardCard({ title, meta, action, children, className = "", id }: { title?: string; meta?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return <section id={id} className={`panel ${className}`}>
    {title && <header className="panel-heading"><div className="flex min-w-0 items-center gap-2"><h2>{title}</h2>{meta}</div>{action}</header>}
    {children}
  </section>;
}
export function EmptyState({ title, description, children, icon = "activity" }: { title: string; description?: string; children?: ReactNode; icon?: IconName }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={22} /></span><h3>{title}</h3>{description && <p>{description}</p>}{children}</div>;
}
export function StatusBadge({ state }: { state: string | null }) {
  const value = state ?? "WATCHING";
  const tone = value === "CONTRADICTED" ? "negative" : value === "TRIGGERED" || value === "STILL_VALID" ? "positive" : value === "MISSED" || value === "RESOLVED" ? "amber" : "neutral";
  return <span className={`status-badge ${tone}`}>{value.replace(/_/g, " ")}</span>;
}
export function CompanyMark({ symbol }: { symbol: string }) {
  return <span className="company-mark" aria-hidden="true">{symbol.replace(/\.(NS|BO)$/, "").slice(0, 2)}</span>;
}
/**
 * A price in its security's own currency. The currency is passed, never assumed:
 * ₹ on a USD security is not a formatting slip, it is a wrong number.
 */
export const formatPrice = (value: number | null, currency: string | null = "INR") =>
  formatMoney(value, currency);
export function PriceChange({ value }: { value: number | null }) {
  return value == null ? <span className="text-faint">—</span> : <span className={`num ${value >= 0 ? "text-up" : "text-down"}`}>{value >= 0 ? "+" : ""}{value.toFixed(2)}%</span>;
}
export type FeedDisplay = { label: string; tone: "positive" | "amber" | "neutral"; asOf: Date | null; timeZone: string };
/**
 * Aggregate freshness across a watchlist, from the OLDEST quote — one recent
 * quote must not make a stale list look current.
 *
 * A mixed-market watchlist never reports a session state. "MARKET CLOSED" can
 * only ever be true of one market at a time, and stamping it across a list
 * holding both INFY.NS and AAPL is the exact claim this product should not make.
 */
export function watchlistFeed(rows: WatchlistRow[], demo = false): FeedDisplay {
  const oldest = rows.some((row) => !row.asOf) ? null : [...rows].sort((a, b) => (a.asOf?.getTime() ?? 0) - (b.asOf?.getTime() ?? 0))[0];
  const health = rows.some((row) => row.health === "unresolved") ? "unresolved" : rows.some((row) => row.health === "degraded") ? "degraded" : "ok";
  const markets = new Set(rows.map((row) => row.security.region ?? row.security.timeZone));
  const feed = feedDisplay(oldest?.asOf ?? null, markets.size > 1 ? null : oldest?.marketState ?? null, health, demo);
  return { ...feed, timeZone: oldest?.security.timeZone ?? IST };
}
export function feedDisplay(asOf: Date | null, marketState: string | null, health = "ok", demo = false, timeZone = IST): FeedDisplay {
  if (demo) return { label: "DEMO REPLAY", tone: "amber", asOf, timeZone };
  if (!asOf) return { label: "AWAITING DATA", tone: "neutral", asOf, timeZone };
  if (health !== "ok") return { label: health === "unresolved" ? "UNRESOLVED" : "DEGRADED", tone: "amber", asOf, timeZone };
  // A closing state belongs to the reported quote; an old close must not mask
  // a days-long outage. Fresh fetch time alone never proves a live feed.
  if (Date.now() - asOf.getTime() > 36 * 3600_000) return { label: "STALE", tone: "amber", asOf, timeZone };
  if (marketState && marketState !== "REGULAR") return { label: "MARKET CLOSED", tone: "neutral", asOf, timeZone };
  return { label: "DELAYED", tone: "amber", asOf, timeZone };
}
/**
 * Freshness for ONE security, on ITS exchange's clock.
 *
 * AAPL is not stale because the NSE is shut, and its last print did not happen
 * at "15:30 IST". Both facts are per security, so both are rendered per row.
 */
export function FreshnessBadge({ asOf, marketState, health = "ok", demo = false, timeZone = IST }: { asOf: Date | null; marketState: string | null; health?: string; demo?: boolean; timeZone?: string }) {
  const feed = feedDisplay(asOf, marketState, health, demo, timeZone);
  return <div className="freshness" title={asOf ? `Exchange time: ${formatExchangeTime(asOf, timeZone)}` : "No valid quote has been received"}>
    <span className={`feed-dot ${feed.tone}`} /><span>{feed.label.toLowerCase()}</span>
    {asOf && <span className="freshness-age">{formatAge(asOf)}</span>}
  </div>;
}
/** "NSE · market closed · 4 Sep, 15:30 IST" — the whole freshness sentence, per security. */
export function ExchangeTime({ asOf, timeZone, prefix }: { asOf: Date | null; timeZone: string; prefix?: string }) {
  if (!asOf) return <span className="text-micro text-faint">{prefix ? `${prefix} · ` : ""}no quote received yet</span>;
  return <span className="text-micro text-faint">{prefix ? `${prefix} · ` : ""}{formatExchangeTime(asOf, timeZone)}</span>;
}
