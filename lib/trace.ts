/**
 * Server-side timing, off unless asked for.
 *
 * Navigation latency is a question about where the time goes, and guessing is how
 * you end up optimising the wrong query. `THESIS_TRACE=1` turns on a one-line log
 * per measured step; without it this is an await passthrough with no allocation
 * and no output, so it is safe to leave in the request path.
 */

const enabled = () => process.env.THESIS_TRACE === "1";

export async function traced<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (!enabled()) return work();
  const started = performance.now();
  try {
    return await work();
  } finally {
    console.log(`[trace] ${label} ${(performance.now() - started).toFixed(0)}ms`);
  }
}

/** Marks the whole render of a route, so page totals can be compared to their parts. */
export function traceRoute(route: string) {
  const started = performance.now();
  return () => {
    if (enabled()) console.log(`[trace] ROUTE ${route} ${(performance.now() - started).toFixed(0)}ms`);
  };
}
