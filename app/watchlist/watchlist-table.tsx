import { removeFromWatchlist } from "@/app/actions";
import { formatAge, formatIST } from "@/lib/time";
import { isUserVisible } from "@/lib/feed-health";
import type { WatchlistRow } from "@/lib/watchlist";

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Freshness is stated, never implied.
 *
 * The one thing this must never do is render a stale price as though it were
 * live, so every row carries the exchange timestamp it came from and says how
 * old it is. Set quietly — it is context, not an alarm.
 */
function Freshness({ row }: { row: WatchlistRow }) {
  if (row.asOf == null) return <span className="text-faint">awaiting first quote</span>;
  const closed = row.marketState != null && row.marketState !== "REGULAR";
  return (
    <span className="text-faint" title={`Exchange time: ${formatIST(row.asOf)} IST`}>
      {formatAge(row.asOf)}
      {closed && <span> · market closed</span>}
    </span>
  );
}

export function WatchlistTable({ rows }: { rows: WatchlistRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-line-strong px-6 py-12 text-center">
        <p className="text-body text-muted">Nothing on your watchlist yet.</p>
        <p className="mt-1 text-meta text-faint">
          Add a symbol above, and tell us why you&rsquo;re watching it.
        </p>
      </div>
    );
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line">
          <th className="label pb-2 text-left font-medium">Symbol</th>
          <th className="label pb-2 text-right font-medium">Price</th>
          <th className="label pb-2 text-right font-medium">Change</th>
          <th className="pb-2" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.symbol} className="border-b border-line align-top last:border-0">
            <td className="py-3 pr-4">
              <Link
                href={`/symbol/${encodeURIComponent(row.symbol)}`}
                className="font-medium underline-offset-2 transition-colors hover:text-accent hover:underline"
              >
                {row.symbol}
              </Link>
              {row.name && <div className="mt-0.5 truncate text-meta text-muted">{row.name}</div>}
              {row.thesisState && row.thesisState !== "WATCHING" && (
                <div className={`mt-1 text-micro ${row.thesisState === "CONTRADICTED" ? "text-contradiction" : row.thesisState === "TRIGGERED" ? "text-trigger" : "text-muted"}`}>
                  Thesis {row.thesisState.replace("_", " ").toLowerCase()}
                </div>
              )}
              <div className="mt-1 text-micro">
                <Freshness row={row} />
              </div>
              {isUserVisible(row.health) && (
                <p className="mt-2 max-w-sm border-l-2 border-down pl-2 text-micro text-down">
                  We have not been able to resolve this symbol in recent updates. It may have been
                  renamed or delisted, and we are not currently monitoring it.
                </p>
              )}
            </td>

            <td className="num py-3 text-right text-emphasis">
              {row.price == null ? <span className="text-faint">—</span> : `₹${inr.format(row.price)}`}
            </td>

            <td className="py-3 pl-4 text-right">
              {row.changePercent == null ? (
                <span className="text-faint">—</span>
              ) : (
                <>
                  <div
                    className={`num text-body ${row.changePercent >= 0 ? "text-up" : "text-down"}`}
                  >
                    {row.changePercent >= 0 ? "+" : ""}
                    {row.changePercent.toFixed(2)}%
                  </div>
                  <div className="text-micro text-faint">vs prev close</div>
                </>
              )}
            </td>

            <td className="py-3 pl-4 text-right">
              <form action={removeFromWatchlist}>
                <input type="hidden" name="symbol" value={row.symbol} />
                <button
                  className="text-micro text-faint transition-colors hover:text-down"
                  aria-label={`Remove ${row.symbol}`}
                >
                  Remove
                </button>
              </form>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
import Link from "next/link";
