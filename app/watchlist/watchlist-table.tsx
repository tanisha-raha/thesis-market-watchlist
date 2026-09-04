import { removeFromWatchlist } from "@/app/actions";
import { formatAge, formatIST } from "@/lib/time";
import { isUserVisible } from "@/lib/feed-health";
import type { WatchlistRow } from "@/lib/watchlist";

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Freshness is never implied — it is stated.
 *
 * Every price carries the exchange timestamp it was reported at, and a price
 * served from storage because the feed did not answer says so explicitly. The
 * one thing this component must never do is render a stale number as though it
 * were live.
 */
function Freshness({ row }: { row: WatchlistRow }) {
  if (row.asOf == null) {
    return <span className="text-[--color-muted]">no quote yet</span>;
  }
  const closed = row.marketState && row.marketState !== "REGULAR";
  return (
    <span className="text-[--color-muted]" title={`Exchange time: ${formatIST(row.asOf)} IST`}>
      {row.servedFromCache && <span className="text-[--color-down]">last known good · </span>}
      {formatAge(row.asOf)}
      {closed ? " · market closed" : ""}
    </span>
  );
}

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded border border-dashed border-[--color-line] px-4 py-10 text-center text-sm text-[--color-muted]">
        Nothing on your watchlist yet. Add a symbol above.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[--color-line] border-y border-[--color-line]">
      {rows.map((row) => (
        <li key={row.symbol} className="flex items-center gap-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{row.symbol}</span>
              {row.name && (
                <span className="truncate text-xs text-[--color-muted]">{row.name}</span>
              )}
            </div>
            <div className="mt-0.5 text-xs">
              <Freshness row={row} />
            </div>
            {isUserVisible(row.health) && (
              <p className="mt-1 text-xs text-[--color-down]">
                We have not been able to resolve this symbol in recent updates. It may have been
                renamed or delisted, and we are not currently monitoring it.
              </p>
            )}
          </div>

          <div className="text-right tabular-nums">
            <div className="text-sm">
              {row.price == null ? "—" : `₹${inr.format(row.price)}`}
            </div>
            {row.changePercent != null && (
              <div
                className={`text-xs ${row.changePercent >= 0 ? "text-[--color-up]" : "text-[--color-down]"}`}
              >
                {row.changePercent >= 0 ? "+" : ""}
                {row.changePercent.toFixed(2)}%
                <span className="ml-1 text-[--color-muted]">vs prev close</span>
              </div>
            )}
          </div>

          <form action={removeFromWatchlist}>
            <input type="hidden" name="symbol" value={row.symbol} />
            <button
              className="text-xs text-[--color-muted] hover:text-[--color-down]"
              aria-label={`Remove ${row.symbol}`}
            >
              Remove
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}
