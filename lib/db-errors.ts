/**
 * Postgres error codes, read through Drizzle's wrapper.
 *
 * Drizzle raises a `DrizzleQueryError` and hangs the driver's error off `cause`,
 * so a naive `(err as {code}).code === "23505"` is always undefined and every
 * unique-violation handler silently fails open. Walk the chain instead.
 */
export function pgErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 23505 — unique constraint violation. */
export const isUniqueViolation = (err: unknown) => pgErrorCode(err) === "23505";
