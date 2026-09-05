/** Shared trigger predicates: identical in historical analysis and monitoring. */
export const BREAKOUT_VOLUME_MULTIPLE = 1.5;
export function priceInRange(price: number, low: number, high: number) {
  return [price, low, high].every(Number.isFinite) && price > 0 && low > 0 && low <= high && price >= low && price <= high;
}
export function breakoutConfirmed(close: number, level: number, volume: number, median: number) {
  return [close, level, volume, median].every(Number.isFinite) && level > 0 && median > 0 && close > level && volume / median >= BREAKOUT_VOLUME_MULTIPLE;
}
export function medianVolume(all: { date: string; volume: number | null }[], asOf: string, window: number): number | null {
  const values = all.filter((s) => s.date <= asOf && s.volume != null && Number.isFinite(s.volume) && s.volume > 0).slice(-window).map((s) => s.volume!).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
