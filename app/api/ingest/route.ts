import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { watchlistItems } from "@/db/schema";
import { ingestQuotes, refreshSymbolStats, detectCorporateActions } from "@/lib/ingestion";
import { runDetection } from "@/lib/detection";
import { liveProvider } from "@/lib/market/live";
import { FULL_UNIVERSE } from "@/lib/universe";

/**
 * Scheduled ingestion, triggered by an external cron.
 *
 * This is the ONLY writer of quotes. Page loads render what this committed, so
 * upstream request volume is a function of the schedule rather than of user
 * traffic — the single cheapest mitigation for the datacenter-IP throttling the
 * brief warns about.
 *
 * Every poll also re-runs change detection. It re-evaluates the full detection
 * window rather than only the newest observations, deliberately: an event that
 * opened days ago can only be RESOLVED by looking at the series that contains
 * it, and narrowing the window to "what is new" would leave long-running events
 * open forever. It costs a couple of seconds for the whole universe and is
 * idempotent, so paying that on every poll is cheaper than the bug.
 *
 * `?stats=1` additionally recomputes `symbol_stats` and re-runs corporate-action
 * detection. Those read the full stored history and are meant for a slower
 * cadence (once a day, after close) rather than every poll.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Constant-time-ish comparison so the secret cannot be probed byte by byte. */
function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorize(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  // Refuse rather than fail open. An unprotected ingestion route is an open
  // proxy to our upstream provider and the fastest way to get rate-limited.
  if (!expected) return false;

  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return secretMatches(bearer, expected);
}

/** Everything we need a current price for: the fixed universe plus anything a user watches. */
async function symbolsToPoll(): Promise<string[]> {
  const watched = await db
    .selectDistinct({ symbol: watchlistItems.symbol })
    .from(watchlistItems);
  return [...new Set([...FULL_UNIVERSE, ...watched.map((w) => w.symbol)])];
}

export async function GET(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const withStats = new URL(request.url).searchParams.get("stats") === "1";
  const startedAt = Date.now();

  try {
    const targets = await symbolsToPoll();
    const quoteResult = await ingestQuotes(liveProvider, targets);

    const body: Record<string, unknown> = {
      ok: true,
      batchId: quoteResult.batchId,
      requested: targets.length,
      succeeded: quoteResult.succeeded,
      // Reported, never silently dropped. A symbol absent from a batched quote
      // response is a fact the operator needs, not a no-op.
      missing: quoteResult.missing,
      ms: Date.now() - startedAt,
    };

    // Detection depends on symbol_stats, so on a stats run it happens after them.
    if (!withStats) body.detection = await runDetection(targets);

    if (withStats) {
      body.stats = await refreshSymbolStats(targets);
      body.corporateActions = await detectCorporateActions(targets);
      body.detection = await runDetection(targets);
    }

    return NextResponse.json(body);
  } catch (error) {
    // The batch row is already marked FAILED by the ingestion layer; this is the
    // operator-facing signal. Returning 502 lets the cron platform surface it.
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "ingestion failed",
        ms: Date.now() - startedAt,
      },
      { status: 502 },
    );
  }
}
