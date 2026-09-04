import { createHash } from "node:crypto";

/**
 * Corporate-action detection from provider-history restatement.
 *
 * We have no corporate-actions feed. What we have is the divergence between what
 * the provider told us on the day (`first_observed_close`) and what it says
 * about that same day now (`current_provider_close`). Phase 0 established that
 * Yahoo restates its entire history when a split occurs, so that ratio IS the
 * split factor — detection falls out of the storage design.
 *
 * The ratio being != 1 is necessary but nowhere near sufficient, so three guards
 * apply before we act on anything:
 *
 *   1. UNIFORMITY — a real split moves the whole prior history by one factor.
 *      A data correction moves one bar. We require every compared bar to agree.
 *   2. TOLERANCE — floats never match exactly, so comparison is banded.
 *   3. PLAUSIBILITY — the factor must sit near a real split ratio. Anything else
 *      is logged and skipped rather than acted upon.
 */

/** Ratios real splits actually produce. Forward splits reduce the price; reverse splits raise it. */
const PLAUSIBLE_FACTORS = [1 / 2, 1 / 3, 2 / 3, 1 / 5, 1 / 10, 1.5, 2, 3, 5, 10];

/** Every compared bar must agree with the mean factor to within this fraction. */
const UNIFORMITY_TOLERANCE = 0.005;   // 0.5%

/** How close the factor must sit to a plausible split ratio. */
const PLAUSIBILITY_TOLERANCE = 0.02;  // 2%

/** Fewer than this many restated bars is not enough evidence to judge. */
const MIN_SUPPORTING_BARS = 3;

export type ObservedShift = { date: string; first: number; current: number };

export type CorporateActionCandidate = {
  status: "VALIDATED" | "REJECTED";
  reason: string;
  fingerprint: string;
  factor: number;
  affectedFrom: string;
  affectedTo: string;
  supportingBars: number;
};

/** Returned when there is not enough evidence to form a candidate at all. */
export type InsufficientEvidence = { status: "INSUFFICIENT"; reason: string };

export type DetectionResult = CorporateActionCandidate | InsufficientEvidence;

export function isCandidate(result: DetectionResult): result is CorporateActionCandidate {
  return result.status !== "INSUFFICIENT";
}

export function detectCorporateAction(symbol: string, values: ObservedShift[]): DetectionResult {
  const ratios = values
    .filter((v) => v.first > 0 && v.current > 0)
    .map((v) => ({ ...v, ratio: v.current / v.first }));

  if (ratios.length < MIN_SUPPORTING_BARS) {
    return { status: "INSUFFICIENT", reason: `fewer than ${MIN_SUPPORTING_BARS} comparable bars` };
  }

  const factor = ratios.reduce((a, v) => a + v.ratio, 0) / ratios.length;
  const uniform = ratios.every((v) => Math.abs(v.ratio - factor) / factor < UNIFORMITY_TOLERANCE);
  const plausible = PLAUSIBLE_FACTORS.some((p) => Math.abs(p - factor) / p < PLAUSIBILITY_TOLERANCE);

  const affectedFrom = ratios[0].date;
  const affectedTo = ratios[ratios.length - 1].date;

  // Keyed on the IDENTITY of the event — symbol, type, affected span — and
  // deliberately NOT on the computed factor. A slightly different bar window
  // yields a slightly different factor, which under a factor-keyed fingerprint
  // would produce a second row for the same real-world split.
  const fingerprint = createHash("sha256")
    .update(`${symbol}|split|${affectedFrom}|${affectedTo}`)
    .digest("hex");

  const reason = !uniform
    ? "non-uniform provider shift — looks like a data correction, not a split"
    : !plausible
      ? `implausible adjustment factor ${factor.toFixed(4)}`
      : "uniform plausible provider-history shift";

  return {
    status: uniform && plausible ? "VALIDATED" : "REJECTED",
    reason,
    fingerprint,
    factor,
    affectedFrom,
    affectedTo,
    supportingBars: ratios.length,
  };
}
