import { formatCount, formatMoney } from "./securities";
import { indexDisplayName } from "./market-brief";
import type { EvidenceEntry } from "./digest";

/**
 * Shapes a stored change event into the Recorded Evidence surface.
 *
 * The question this answers is narrow and worth stating: WHAT DID THESIS OBSERVE
 * WHEN THIS EVENT WAS DETECTED? Not whether a thesis was right — that belongs to
 * My Thesis — and not whether the combination was unusual, which is the anomaly
 * layer's separate claim.
 *
 * Pure, and reads ONLY the stored `explain_json`. Nothing is recomputed from the
 * latest quote: an event's evidence is what was true when the claim was made, and
 * a number that drifted afterwards would be evidence for a claim we are no longer
 * making. A field the event did not record is simply absent — there is no tile to
 * fill and nothing is invented to fill it.
 */

export type EvidenceTile = {
  key: string;
  label: string;
  value: string;
  /** What the figure was measured against. A number without it is an assertion. */
  detail?: string;
};

export type RecordedEvidenceView = {
  /** The event in human words: "Price move", "Unusual volume". */
  headline: string;
  tiles: EvidenceTile[];
  context: EvidenceEntry[];
  /** One descriptive sentence, or null when the evidence does not support one. */
  interpretation: string | null;
};

const SIGNAL_LABELS: Record<string, string> = {
  price_move: "Price move",
  volume_anomaly: "Unusual volume",
  benchmark_residual: "Move against the market",
  cross_52w_high: "52-week high crossed",
  cross_52w_low: "52-week low crossed",
  cross_20d_high: "20-day high crossed",
  cross_20d_low: "20-day low crossed",
  trend_above_ma20: "Crossed above the 20-day average",
  trend_below_ma20: "Crossed below the 20-day average",
  overnight_gap: "Opening gap",
};

export function signalLabel(signalType: string): string {
  return SIGNAL_LABELS[signalType] ?? signalType.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const percent = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const magnitude = (value: number, digits = 2) => `${Math.abs(value).toFixed(digits)}%`;

/**
 * The two or three figures that carry the event, chosen from what was recorded.
 *
 * Ordered by how directly each answers "what happened": the move itself, then how
 * much trading it took, then how much of it was the company rather than the
 * market. A level-crossing event records none of those, so it falls through to
 * the level it crossed — the candidate list is a priority, not a fixed layout.
 */
function tilesFrom(explain: Record<string, unknown>, signalType: string, currency: string | null): EvidenceTile[] {
  const z = number(explain.z_vs_20d_realized_vol);
  const move = number(explain.return_pct) ?? number(explain.stock_return_pct) ?? number(explain.gap_pct);
  const volumeRatio = number(explain.volume_vs_median);
  const residual = number(explain.residual_pct);
  const level = number(explain.level);
  const price = number(explain.price);
  const distanceFromMa = number(explain.distance_from_ma_pct);

  const candidates: (EvidenceTile | null)[] = [
    move == null ? null : {
      key: "move",
      label: signalType === "overnight_gap" ? "Opening gap" : "Price move",
      value: percent(move),
      detail: z == null ? "vs previous close" : `${Math.abs(z).toFixed(1)}σ vs recent volatility`,
    },
    volumeRatio == null ? null : {
      key: "volume",
      label: "Relative volume",
      value: `${volumeRatio.toFixed(1)}×`,
      detail: "vs 20-day median",
    },
    residual == null ? null : {
      key: "residual",
      label: "Vs market",
      value: percent(residual),
      detail: "stock-specific move",
    },
    level == null ? null : {
      key: "level",
      label: "Level crossed",
      value: formatMoney(level, currency),
      detail: typeof explain.level_source === "string" ? explain.level_source : undefined,
    },
    distanceFromMa == null ? null : {
      key: "ma",
      label: "Distance from average",
      value: magnitude(distanceFromMa),
      // The stored figure is a magnitude; the direction is the event's own type,
      // not something inferred from the number's sign.
      detail: signalType.includes("below") ? "below the 20-day average" : signalType.includes("above") ? "above the 20-day average" : "from the 20-day average",
    },
    price == null ? null : {
      key: "price",
      label: "Price at detection",
      value: formatMoney(price, currency),
      detail: "recorded price",
    },
  ];

  return candidates.filter((tile): tile is EvidenceTile => tile != null).slice(0, 3);
}

/** The quieter row of what the move happened against. */
function contextFrom(explain: Record<string, unknown>, currency: string | null, shown: Set<string>): EvidenceEntry[] {
  const rows: EvidenceEntry[] = [];
  const push = (label: string, value: string | null, basis?: string) => {
    if (value != null) rows.push({ label, value, basis });
  };

  const benchmarkReturn = number(explain.benchmark_return_pct);
  if (benchmarkReturn != null) {
    // The index by the name people use, never the provider's ticker.
    const benchmark = typeof explain.benchmark === "string" ? explain.benchmark : null;
    push(benchmark ? indexDisplayName(benchmark) : "Benchmark", percent(benchmarkReturn));
  }
  const beta = number(explain.beta_60d);
  if (beta != null) push("60-day beta", beta.toFixed(2));
  const expected = number(explain.expected_from_benchmark_pct);
  if (expected != null) push("Market-implied move", percent(expected), "from beta and the index move");
  const vol = number(explain.realized_vol_20d_daily);
  if (vol != null) push("20-day realized volatility", `${(vol * 100).toFixed(2)}%`, "daily");
  const ma = number(explain.ma_20d);
  if (ma != null) push("20-day average", formatMoney(ma, currency));
  const previousClose = number(explain.previous_close) ?? number(explain.previous_close_raw);
  if (previousClose != null) push("Previous close", formatMoney(previousClose, currency));
  const open = number(explain.open);
  if (open != null) push("Open", formatMoney(open, currency));
  const volume = number(explain.volume);
  if (volume != null) push("Volume", formatCount(volume, currency));
  const medianVolume = number(explain.median_volume_20d);
  if (medianVolume != null) push("20-day median volume", formatCount(medianVolume, currency));
  const price = number(explain.price);
  if (price != null && !shown.has("price")) push("Price at detection", formatMoney(price, currency));
  const level = number(explain.level);
  if (level != null && !shown.has("level")) push("Level", formatMoney(level, currency));

  return rows;
}

/**
 * One descriptive sentence about what was recorded — deterministic, and silent
 * when the numbers do not support one.
 *
 * Describes only what the stored figures say, in the past tense. No direction is
 * called good or bad, nothing is attributed to a cause, and nothing is projected
 * forward: those would be three different products.
 */
function interpret(explain: Record<string, unknown>, company: string): string | null {
  const z = number(explain.z_vs_20d_realized_vol);
  const residual = number(explain.residual_pct);
  const benchmarkReturn = number(explain.benchmark_return_pct);
  const volumeRatio = number(explain.volume_vs_median);

  if (residual != null && benchmarkReturn != null && Math.abs(residual) >= 1 && Math.abs(residual) >= 2 * Math.abs(benchmarkReturn)) {
    return `${company} moved substantially more than the broader market during this recorded event.`;
  }
  if (z != null && Math.abs(z) >= 2 && benchmarkReturn != null && Math.abs(benchmarkReturn) < 0.3) {
    return "The move was large relative to the company’s recent volatility while the broader market was nearly flat.";
  }
  if (z != null && Math.abs(z) >= 2 && volumeRatio != null && volumeRatio >= 2) {
    return "The move was large relative to recent volatility and came with trading well above the company’s recent median.";
  }
  if (volumeRatio != null && volumeRatio >= 2) {
    return "Trading volume for this session was well above the company’s recent median.";
  }
  if (z != null && Math.abs(z) >= 2) {
    return "The move was large relative to the company’s own recent volatility.";
  }
  return null;
}

export function recordedEvidence(input: {
  signalType: string;
  explain: Record<string, unknown>;
  currency: string | null;
  company: string;
}): RecordedEvidenceView {
  const tiles = tilesFrom(input.explain, input.signalType, input.currency);
  return {
    headline: signalLabel(input.signalType),
    tiles,
    context: contextFrom(input.explain, input.currency, new Set(tiles.map((tile) => tile.key))),
    interpretation: interpret(input.explain, input.company),
  };
}
