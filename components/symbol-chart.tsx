"use client";
import { useState } from "react";
import { PriceChart } from "@/components/price-chart";
import { EmptyState } from "@/components/ui";
import { availableRanges, defaultRange, rangeSeries, type IntradayPoint, type RangeKey } from "@/lib/chart-ranges";
import { exchangeDate, formatInZone } from "@/lib/time";
import type { HistoryPoint } from "@/lib/presentation";

/**
 * Price history with ranges, over observations that exist.
 *
 * Only ranges the data path can actually answer are offered: intraday buttons
 * appear when there is an observed intraday path, daily buttons when there are
 * enough stored or provider bars. Nothing is interpolated between them — a "1D"
 * button that drew a line between two daily closes would be a different
 * measurement wearing the same label.
 */
export function SymbolChart({ daily, intraday, exchange, timeZone, source }: {
  daily: HistoryPoint[];
  intraday: IntradayPoint[];
  exchange: string | null;
  timeZone: string;
  source: "stored" | "lookup" | "none";
}) {
  const dateOf = (at: Date) => exchangeDate(at, timeZone);
  const ranges = availableRanges(daily, intraday, dateOf);
  const initial = defaultRange(ranges);
  const [range, setRange] = useState<RangeKey | null>(initial);
  const active = range && ranges.includes(range) ? range : initial;

  if (!active) {
    return <div className="panel-body">
      <EmptyState
        title={source === "none" ? "Price history temporarily unavailable" : "Not enough observed history to chart yet"}
        description={source === "none"
          ? "The provider did not return usable history for this company. Its quote, freshness and everything else on this page are unaffected."
          : "A chart appears once enough usable observations have been recorded."} />
    </div>;
  }

  const series = rangeSeries(active, daily, intraday, dateOf);
  const intradayRange = active === "1D" || active === "1W";
  const points: HistoryPoint[] = intradayRange
    ? series.intraday.map((point) => ({ date: formatInZone(new Date(point.at), timeZone), close: point.price }))
    : series.daily;

  return <div className="panel-body">
    <div className="chart-ranges" role="group" aria-label="Chart range">
      {ranges.map((key) => (
        <button key={key} type="button" className={key === active ? "active" : ""} aria-pressed={key === active} onClick={() => setRange(key)}>{key}</button>
      ))}
    </div>
    <PriceChart
      points={points}
      exchange={exchange ? `${exchange} ${intradayRange ? "time" : "dates"}` : null}
      series={intradayRange ? "Observed price path" : "Adjusted daily closes"}
      unit={intradayRange ? "observations" : "sessions"}
    />
    <p className="text-micro text-faint mt-3">
      {intradayRange
        ? "The intraday path THESIS actually observed — polled quotes and seeded 5-minute closes. Gaps are moments we did not observe, never interpolated."
        : "Adjusted daily closes, traded sessions only."}
      {source === "lookup" && " Fetched live for this lookup and not stored: this company is not being monitored yet."}
    </p>
  </div>;
}
