import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { symbols } from "@/db/schema";
import { describeSecurity, type Security } from "@/lib/securities";

/**
 * Stored security metadata, resolved into the shape the rest of the app reads.
 *
 * One query for a set of symbols rather than a lookup per row, and one place
 * where "what market is this in" is answered from the database — the pure rules
 * live in lib/securities.ts, this is only the read.
 */
export async function loadSecurities(symbolList: string[]): Promise<Map<string, Security>> {
  const wanted = [...new Set(symbolList)];
  const found = new Map<string, Security>();
  if (wanted.length === 0) return found;

  const rows = await db
    .select({
      symbol: symbols.symbol, name: symbols.name, exchange: symbols.exchange,
      currency: symbols.currency, timeZone: symbols.exchangeTimezone,
    })
    .from(symbols)
    .where(inArray(symbols.symbol, wanted));
  for (const row of rows) found.set(row.symbol, describeSecurity(row));

  // A symbol with no row yet still needs a market: infer it from the ticker
  // rather than skipping the security entirely.
  for (const symbol of wanted) if (!found.has(symbol)) found.set(symbol, describeSecurity({ symbol }));
  return found;
}
