import { DashboardCard, EmptyState, formatPrice } from "@/components/ui";
import { Evidence } from "@/components/evidence";
import { SymbolChart } from "@/components/symbol-chart";
import { getLookupHistory, type CompanyStats } from "@/lib/company";
import { formatCount } from "@/lib/securities";
import type { IntradayPoint } from "@/lib/chart-ranges";

/**
 * The two panels that depend on a provider request for a company nobody watches.
 *
 * They render exactly what they always rendered — the same bars, the same session
 * figures, the same truthful empty states — but from inside a Suspense boundary,
 * so a slow provider delays these panels instead of the whole page. Both call the
 * same memoised read, so there is still only one request.
 */
export async function PriceHistorySection({ symbol, intraday, exchange, timeZone }: {
  symbol: string; intraday: IntradayPoint[]; exchange: string | null; timeZone: string;
}) {
  const { daily } = await getLookupHistory(symbol);
  return <DashboardCard title="Price History" action={<span className="status-badge neutral">{daily.length >= 2 ? "LIVE LOOKUP" : "UNAVAILABLE"}</span>}>
    <SymbolChart daily={daily} intraday={intraday} exchange={exchange} timeZone={timeZone} source={daily.length >= 2 ? "lookup" : "none"} />
  </DashboardCard>;
}

export function PriceHistorySkeleton() {
  return <DashboardCard title="Price History" action={<span className="status-badge neutral">LIVE LOOKUP</span>} className="is-loading">
    <div className="panel-body" aria-busy="true"><div className="chart-placeholder" /></div>
  </DashboardCard>;
}

export async function MarketDataSection({ symbol, currency, previousClose, stats }: {
  symbol: string; currency: string | null; previousClose: number | null; stats: CompanyStats | null;
}) {
  const { latestBar: bar } = await getLookupHistory(symbol);
  const money = (value: number | null) => formatPrice(value, currency);
  const rows = [
    { label: "Open", value: bar?.open != null ? money(bar.open) : null },
    { label: "High", value: bar?.high != null ? money(bar.high) : null },
    { label: "Low", value: bar?.low != null ? money(bar.low) : null },
    { label: "Previous close", value: previousClose != null ? money(previousClose) : null },
    { label: "Volume", value: bar?.volume != null ? formatCount(bar.volume, currency) : null },
    { label: "Median volume", value: stats?.medianVolume20 != null ? formatCount(stats.medianVolume20, currency) : null, basis: "20 sessions" },
    { label: "Realized volatility", value: stats?.realizedVol20 != null ? `${(stats.realizedVol20 * 100).toFixed(2)}%` : null, basis: "daily, 20-day" },
    { label: "20-day average", value: stats?.ma20 != null ? money(stats.ma20) : null },
  ].flatMap((row) => row.value ? [{ label: row.label, value: row.value, basis: row.basis }] : []);

  return <DashboardCard title="Market Data" action={<span className="eyebrow">{bar ? `SESSION ${bar.date}` : "LATEST QUOTE"}</span>}>
    {rows.length
      ? <div className="panel-body"><Evidence entries={rows} /></div>
      : <EmptyState title="No session data available yet" description="Open, volume and reference levels appear once usable history has been observed for this company." />}
  </DashboardCard>;
}

export function MarketDataSkeleton() {
  return <DashboardCard title="Market Data" action={<span className="eyebrow">LATEST QUOTE</span>} className="is-loading">
    <div className="panel-body" aria-busy="true"><div className="rows-placeholder" /></div>
  </DashboardCard>;
}
