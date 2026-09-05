import { useId } from "react";
import type { HistoryPoint } from "@/lib/presentation";
import { EmptyState } from "@/components/ui";

/**
 * Renders observations that were actually recorded — never a fabricated path.
 *
 * `series` names what the points ARE, because this now draws two different
 * measurements: daily closes, and the observed intraday price path. Labelling an
 * intraday chart "daily closes" would be a smaller lie than inventing the points,
 * but it would still be one.
 */
export function PriceChart({ points, compact = false, exchange, series = "Adjusted daily closes", unit = "stored sessions", empty }: {
  points: HistoryPoint[]; compact?: boolean; exchange?: string | null; series?: string; unit?: string; empty?: string;
}) {
  const gradient = `chart-${useId().replace(/:/g, "")}`;
  if (points.length < 2) return <EmptyState title={empty ?? "Price history is not available yet"} description="Your last-known quote stays visible. A chart will appear when usable stored history is available." />;
  const values = points.map((point) => point.close);
  const low = Math.min(...values), high = Math.max(...values);
  const range = high - low || high * .02 || 1;
  const path = points.map((point, i) => `${i === 0 ? "M" : "L"}${(i / (points.length - 1) * 560 + 10).toFixed(2)},${(132 - (point.close - low) / range * 110).toFixed(2)}`).join(" ");
  const up = values.at(-1)! >= values[0];
  return <figure className={`price-chart ${compact ? "compact" : ""}`}>
    <div className="chart-label"><span>{series}</span><span>{points.length} {unit}</span></div>
    <svg viewBox="0 0 580 154" role="img" aria-label={`${series} from ${points[0].date} to ${points.at(-1)!.date}`} preserveAspectRatio="none" className={up ? "text-up" : "text-down"}>
      <defs><linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity=".16" /><stop offset="100%" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      {[24, 60, 96, 132].map((y) => <line key={y} x1="0" x2="580" y1={y} y2={y} stroke="var(--color-line)" strokeWidth=".65" />)}
      <path d={`${path} L570,150 L10,150 Z`} fill={`url(#${gradient})`} />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
    <figcaption><span>{points[0].date}</span><span>Through {points.at(-1)!.date}{exchange ? ` · ${exchange}` : ""}</span></figcaption>
  </figure>;
}
