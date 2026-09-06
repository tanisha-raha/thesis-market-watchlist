"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { removeFromWatchlist } from "@/app/actions";
import type { WatchlistRow } from "@/lib/watchlist";
import { CompanyMark, EmptyState, formatPrice, FreshnessBadge, PriceChange, StatusBadge } from "@/components/ui";
import { marketLine } from "@/lib/securities";
import { AddStockButton } from "@/components/workspace-controls";
import { ThesisHealthBadge } from "@/components/thesis-health-badge";
import type { ThesisHealth } from "@/lib/thesis-health";

export function WatchlistTable({ rows, demo = false, conditions = {}, health = {} }: {
  rows: WatchlistRow[]; demo?: boolean; conditions?: Record<string, string>;
  /** Only present for rows with a structured condition; absent means nothing to report. */
  health?: Record<string, ThesisHealth>;
}) {
  const router = useRouter();
  if (!rows.length) return <EmptyState title="Nothing on your watchlist yet." description="Start with a company you follow. Add an optional thesis, and keep the reason behind your watchlist in view." icon="watchlist"><AddStockButton label="Add your first stock" /></EmptyState>;
  return <><div className="table-scroll" tabIndex={0} aria-label="Watchlist table"><table className="watchlist-table"><thead><tr><th>#</th><th>Company / Symbol</th><th className="text-right">Price</th><th className="text-right">Change</th><th>Freshness</th><th>Thesis condition</th><th>Thesis Health</th><th>Thesis Status</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>
    {rows.map((row, index) => <tr key={row.symbol} onClick={(event) => { if (!(event.target as HTMLElement).closest("a,button,input,form")) router.push(`/symbol/${encodeURIComponent(row.symbol)}`); }}>
      <td className="row-number num">{index + 1}</td><td><div className="company-cell"><CompanyMark symbol={row.symbol} /><div><p title={row.name ?? row.symbol}>{row.name ?? row.symbol.replace(/\.(NS|BO)$/, "")}</p><Link href={`/symbol/${encodeURIComponent(row.symbol)}`}>{row.symbol}</Link>{marketLine(row.security) && <small className="company-market">{marketLine(row.security)}</small>}</div></div>{row.health === "unresolved" && <p className="unresolved-note">Unresolved in recent updates. Not currently monitored.</p>}</td>
      <td className="num price-cell">{formatPrice(row.price, row.security.currency)}</td><td className="change-cell"><PriceChange value={row.changePercent} /><small>vs prev close</small></td><td><FreshnessBadge asOf={row.asOf} marketState={row.marketState} health={row.health} demo={demo} timeZone={row.security.timeZone} /></td><td className="condition-cell">{conditions[row.symbol] ?? "Just watching"}</td><td className="health-cell">{health[row.symbol] ? <ThesisHealthBadge health={health[row.symbol]} compact /> : <span className="text-faint">—</span>}</td><td><StatusBadge state={row.thesisState} /></td><td><form action={removeFromWatchlist}><input type="hidden" name="symbol" value={row.symbol} /><button className="row-remove" aria-label={`Remove ${row.symbol}`} title={`Remove ${row.symbol}`}>×</button></form></td>
    </tr>)}
  </tbody></table></div><p className="table-scroll-hint">Swipe for change, freshness and actions →</p><p className="page-note">Thesis Health evaluates the condition you stated, not the company or its expected return.</p></>;
}
