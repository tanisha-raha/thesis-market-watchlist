/** Read-only migration/schema inventory. Never outputs connection strings or user data. */
import postgres from "postgres";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in the environment.");
const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const journal = JSON.parse(await readFile("db/migrations/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] };
  const applied = await client`select hash, created_at from drizzle.__drizzle_migrations order by created_at`;
  const appliedCutoff = Math.max(0, ...applied.map((row) => Number(row.created_at)));
  const migrations = await Promise.all(journal.entries.map(async (entry) => {
    const hash = createHash("sha256").update(await readFile(`db/migrations/${entry.tag}.sql`, "utf8")).digest("hex");
    const hashMatches = applied.some((row) => row.hash === hash);
    const timestampMatches = applied.some((row) => Number(row.created_at) === entry.when);
    return { migration: entry.tag, status: hashMatches ? "APPLIED" : timestampMatches ? "APPLIED_HASH_DIFFERS" : entry.when <= appliedCutoff ? "BELOW_APPLIED_CUTOFF_VERIFY" : "PENDING", hashMatches };
  }));
  console.log(JSON.stringify({ migrations }, null, 2));
  const columns = await client`select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='users' order by ordinal_position`;
  const counts: Record<string, number | null> = {};
  for (const table of ["users", "sessions", "watchlist_items", "quotes", "price_bars", "quote_observations", "symbol_stats", "change_events", "theses", "thesis_events", "user_symbol_read_state"]) {
    const [exists] = await client`select to_regclass(${`public.${table}`}) as name`;
    counts[table] = exists.name ? Number((await client.unsafe(`select count(*) as count from "${table}"`))[0].count) : null;
  }
  console.log(JSON.stringify({ userColumns: columns, counts }, null, 2));
} finally { await client.end(); }
