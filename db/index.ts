import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");

// Opt-in operational metadata only. Never log the hostname, URL or credentials.
if (process.env.THESIS_TRACE === "1") {
  const host = new URL(url).hostname;
  console.log(`[trace] database region=${host.match(/([a-z]+-[a-z]+-\d+)/)?.[1] ?? "local-or-unknown"} function=${process.env.VERCEL_REGION ?? "local"}`);
}

/**
 * One driver for local Postgres and for Neon, over plain TCP against Neon's
 * pooled endpoint. Serverless invocations are short-lived, so the pool is capped
 * low and idle connections are reaped quickly to avoid exhausting Neon's limit.
 */
const client = postgres(url, {
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // pgbouncer in transaction mode cannot support prepared statements
});

export const db = drizzle(client, { schema });
export { schema };

/**
 * Either the pooled client or an open transaction handle.
 *
 * Any function that writes and might be called from inside `db.transaction()`
 * MUST take one of these and use it, rather than closing over `db`. Drizzle
 * binds `tx` to a reserved connection, so a helper that reaches for the
 * module-level `db` silently issues its writes on a DIFFERENT connection —
 * outside the transaction, and surviving its rollback.
 */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
