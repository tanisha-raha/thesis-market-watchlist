import { formatMoney } from "./securities";

/**
 * How a stored thesis reads back to the user.
 *
 * Pure and component-free so the watchlist, the symbol page and the test suite
 * all render a condition the same way — and so that "does a US condition read
 * back in dollars" is a test rather than a screenshot.
 */
export const thesisLabel = (type: string) => ({
  price_range: "Waiting for a dip", breakout: "Watching for a breakout",
  momentum_up: "Tracking momentum", momentum_down: "Tracking a decline",
  volatility_watch: "Watching for unusual moves", volume_expansion: "Watching for volume expansion",
  none: "Just watching",
}[type] ?? type.replace(/_/g, " "));

/** A stored condition, in the currency the user typed it in. */
export function thesisCondition(type: string, params: unknown, currency: string | null = "INR"): string {
  const p = (params ?? {}) as Record<string, unknown>;
  if (type === "price_range" && typeof p.low === "number" && typeof p.high === "number") {
    return `${formatMoney(p.low, currency)} – ${formatMoney(p.high, currency)}`;
  }
  if (type === "breakout" && typeof p.level === "number") return `Above ${formatMoney(p.level, currency)}`;
  return thesisLabel(type);
}
