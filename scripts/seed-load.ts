/**
 * Loads the committed seed files into the database.
 *
 * This is the deploy-time counterpart to the seed fetch scripts. Nothing here
 * touches the network — the whole point is that the deployed app never performs
 * a cold historical backfill against Yahoo.
 *
 * Idempotent: rerunning does not duplicate rows, and it never rewrites the
 * first-observed columns in `price_bars`.
 *
 * Run: npm run seed:load
 */
import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ingestionBatches, priceBars, quoteObservations, symbols } from "@/db/schema";

const DAILY = "seed/daily.ndjson.gz";
const INTRADAY = "seed/intraday-5m.ndjson.gz";
const CHUNK = 2_000;

type DailyRow = [string, number | null, number | null, number | null, number | null, number | null, number | null];
type IntradayRow = [number, number | null, number | null, number | null, number | null, number | null];

const excluded = (c: string) => sql.raw(`excluded.${c}`);
const num = (n: number | null | undefined) => (n == null ? null : String(n));

async function* readSeed<T>(path: string): AsyncGenerator<{ symbol: string; rows: T[] }> {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line);
  }
}

async function chunked<T>(items: T[], size: number, fn: (batch: T[]) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
}

async function openBatch(label: string) {
  const [batch] = await db
    .insert(ingestionBatches)
    .values({ status: "STARTED", requestedCount: 0, failureSummary: label })
    .returning();
  return batch;
}

async function completeBatch(id: number, count: number) {
  await db
    .update(ingestionBatches)
    .set({ status: "COMPLETED", completedAt: new Date(), successCount: count })
    .where(sql`${ingestionBatches.id} = ${id}`);
}

/* --------------------------------------------------------------- daily bars */

async function loadDaily(): Promise<number> {
  if (!existsSync(DAILY)) {
    console.log(`  ${DAILY} not present — skipping (run npm run seed:daily)`);
    return 0;
  }
  const batch = await openBatch("seed:daily");
  const now = new Date();
  let loaded = 0;

  for await (const { symbol, rows } of readSeed<DailyRow>(DAILY)) {
    // The symbol must exist before its bars can reference it.
    await db.insert(symbols).values({ symbol }).onConflictDoNothing();

    const values = rows.map(([date, open, , , close, adjClose, volume]) => ({
      symbol,
      tradingDate: date,
      firstObservedClose: num(close),
      firstObservedVolume: num(volume),
      firstObservedAt: now,
      firstObservedBatchId: batch.id,
      currentProviderOpen: num(open),
      currentProviderClose: num(close),
      currentProviderAdjClose: num(adjClose),
      currentProviderVolume: num(volume),
      refreshedAt: now,
      refreshedBatchId: batch.id,
    }));

    await chunked(values, CHUNK, async (part) => {
      await db.insert(priceBars).values(part).onConflictDoUpdate({
        target: [priceBars.symbol, priceBars.tradingDate],
        // first_observed_* is absent on purpose — written once, never updated.
        set: {
          currentProviderOpen: excluded("current_provider_open"),
          currentProviderClose: excluded("current_provider_close"),
          currentProviderAdjClose: excluded("current_provider_adj_close"),
          currentProviderVolume: excluded("current_provider_volume"),
          refreshedAt: excluded("refreshed_at"),
          refreshedBatchId: excluded("refreshed_batch_id"),
        },
      });
    });

    loaded += values.length;
    process.stdout.write(`\r  daily: ${symbol.padEnd(16)} ${loaded} bars loaded   `);
  }

  await completeBatch(batch.id, loaded);
  console.log();
  return loaded;
}

/* ------------------------------------------------------------ intraday path */

async function loadIntraday(): Promise<number> {
  if (!existsSync(INTRADAY)) {
    console.log(`  ${INTRADAY} not present — skipping (run npm run seed:intraday)`);
    return 0;
  }
  const batch = await openBatch("seed:intraday-5m");
  const now = new Date();
  let loaded = 0;

  for await (const { symbol, rows } of readSeed<IntradayRow>(INTRADAY)) {
    await db.insert(symbols).values({ symbol }).onConflictDoNothing();

    // Only the close is stored. A threshold crossing that reverses inside a
    // single 5-minute bar is below our detection resolution, and storing the
    // bar's high as if it were an observation would claim precision we do not
    // have. The committed seed file retains full OHLCV if we ever want it.
    const values = rows
      .filter(([, , , , close]) => close != null && Number.isFinite(close))
      .map(([ts, , , , close]) => ({
        batchId: batch.id,
        symbol,
        price: String(close),
        previousClose: null,
        asOf: new Date(ts * 1000),
        marketState: null,
        source: "bar_5m",
        fetchedAt: now,
      }));

    await chunked(values, CHUNK, async (part) => {
      await db.insert(quoteObservations).values(part).onConflictDoNothing({
        target: [quoteObservations.symbol, quoteObservations.asOf, quoteObservations.source],
      });
    });

    loaded += values.length;
    process.stdout.write(`\r  intraday: ${symbol.padEnd(16)} ${loaded} observations loaded   `);
  }

  await completeBatch(batch.id, loaded);
  console.log();
  return loaded;
}

const daily = await loadDaily();
const intraday = await loadIntraday();
console.log(`\nloaded ${daily} daily bars and ${intraday} intraday observations`);
process.exit(0);
