import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");

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
