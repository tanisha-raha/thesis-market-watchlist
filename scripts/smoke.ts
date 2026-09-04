/**
 * End-to-end smoke test of the vertical slice against a real database and the
 * real feed. Not a unit test suite — it verifies the slice actually works.
 *
 * Run: npm run smoke   (requires DATABASE_URL)
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { quotes, symbols, users, watchlistItems } from "@/db/schema";
import { authenticate, registerUser } from "@/lib/auth";
import { addSymbol, getWatchlist, removeSymbol } from "@/lib/watchlist";
import { classify, recordPollOutcome, TERMINAL_MISS_THRESHOLD } from "@/lib/feed-health";
import { deriveTradingCalendar, alignSeries, isTradedEquityBar } from "@/lib/market/calendar";
import { liveProvider } from "@/lib/market/live";
import type { Bar } from "@/lib/market/types";

let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}${detail && ` — ${detail}`}`); }
  else { failed++; console.log(`  ✗ ${label}${detail && ` — ${detail}`}`); }
}
const section = (t: string) => console.log(`\n${t}`);

const email = `smoke+${Date.now()}@example.com`;

section("auth");
const reg = await registerUser(email, "correct-horse-battery");
check("register succeeds", reg.ok);
const dup = await registerUser(email, "correct-horse-battery");
check("duplicate email rejected", !dup.ok && dup.error.includes("already exists"), dup.ok ? "" : dup.error);
const weak = await registerUser(`x${Date.now()}@example.com`, "short");
check("short password rejected", !weak.ok);
const good = await authenticate(email, "correct-horse-battery");
check("correct password authenticates", good.ok);
const bad = await authenticate(email, "wrong-password");
check("wrong password rejected", !bad.ok);
const ghost = await authenticate("nobody@example.com", "whatever");
check("unknown email gives same generic error", !ghost.ok && !bad.ok && ghost.error === bad.error, ghost.ok ? "" : ghost.error);

if (!reg.ok) { console.log("\ncannot continue without a user"); process.exit(1); }
const userId = reg.userId;

section("watchlist");
const add = await addSymbol(userId, "reliance.ns"); // lowercase on purpose
check("adds a real symbol (case-insensitive)", add.ok, add.ok ? "" : add.error);
const addDup = await addSymbol(userId, "RELIANCE.NS");
check("re-adding is idempotent, not an error", addDup.ok, addDup.ok ? "" : addDup.error);
const dupRows = await db.select().from(watchlistItems).where(eq(watchlistItems.userId, userId));
check("no duplicate row created", dupRows.length === 1, `${dupRows.length} row(s)`);
const junk = await addSymbol(userId, "NOTAREALTICKER.NS");
check("unresolvable symbol refused", !junk.ok, junk.ok ? "" : junk.error);

await addSymbol(userId, "TCS.NS");
const list = await getWatchlist(userId);
check("watchlist returns both symbols", list.length === 2, list.map((r) => r.symbol).join(", "));
const rel = list.find((r) => r.symbol === "RELIANCE.NS")!;
check("price populated", rel.price != null && rel.price > 0, `₹${rel.price}`);
check("asOf is a real exchange timestamp", rel.asOf != null && rel.asOf.getFullYear() > 2000, rel.asOf?.toISOString());
check("asOf is not our fetch time", rel.asOf != null && Math.abs(Date.now() - rel.asOf.getTime()) < 7 * 864e5);
check("marketState present", rel.marketState != null, String(rel.marketState));
check("change vs previous close computed", rel.changePercent != null, `${rel.changePercent?.toFixed(2)}%`);
check("health starts ok", rel.health === "ok");
check("watchlist renders from stored quotes, not a per-request fetch", rel.asOf != null);

const storedQuote = await db.select().from(quotes).where(eq(quotes.symbol, "RELIANCE.NS"));
check("quote persisted for last-known-good", storedQuote.length === 1);

await removeSymbol(userId, "TCS.NS");
check("remove works", (await getWatchlist(userId)).length === 1);

section("feed health — transient vs terminal");
await recordPollOutcome(db, [], ["RELIANCE.NS"]);
let s = (await db.select().from(symbols).where(eq(symbols.symbol, "RELIANCE.NS")))[0];
check("one miss counts but stays invisible", classify(s.consecutiveFeedMisses) === "degraded", `misses=${s.consecutiveFeedMisses}`);
for (let i = 1; i < TERMINAL_MISS_THRESHOLD; i++) await recordPollOutcome(db, [], ["RELIANCE.NS"]);
s = (await db.select().from(symbols).where(eq(symbols.symbol, "RELIANCE.NS")))[0];
check(`${TERMINAL_MISS_THRESHOLD} misses escalates to unresolved`, classify(s.consecutiveFeedMisses) === "unresolved", `misses=${s.consecutiveFeedMisses}`);
await recordPollOutcome(db, ["RELIANCE.NS"], []);
s = (await db.select().from(symbols).where(eq(symbols.symbol, "RELIANCE.NS")))[0];
check("a successful poll resets the counter", s.consecutiveFeedMisses === 0);

section("batch reconciliation against the live feed");
const batch = await liveProvider.getQuotes(["RELIANCE.NS", "TCS.NS", "NOTAREALTICKER.NS"]);
check("resolvable symbols returned", batch.quotes.length === 2, batch.quotes.map((q) => q.symbol).join(", "));
check("silently-dropped symbol is reported", batch.missing.includes("NOTAREALTICKER.NS"), `missing=[${batch.missing}]`);

section("trading calendar from observed bars");
const bars = await liveProvider.getDailyBars("RELIANCE.NS", 400);
const holiday = bars.find((b) => b.date === "2026-06-26");
check("2026-06-26 bar exists in the feed", holiday != null);
check("...but is not a traded session", holiday != null && !isTradedEquityBar(holiday), `close=${holiday?.close} volume=${holiday?.volume}`);
const cal = deriveTradingCalendar([bars]);
check("holiday excluded from derived calendar", !cal.has("2026-06-26"));
check("calendar has a plausible session count", cal.size > 200 && cal.size < 300, `${cal.size} sessions in ~400 days`);

const idx = await liveProvider.getDailyBars("^NSEI", 400);
const aligned = alignSeries(bars, idx);
check("aligned series drops null-close index days", aligned.length > 0 && aligned.every((p) => Number.isFinite(p.a) && Number.isFinite(p.b)), `${aligned.length} usable pairs`);
check("alignment loses only a few days", bars.length - aligned.length < 15, `${bars.length} bars → ${aligned.length} pairs`);

// cleanup
await db.delete(users).where(eq(users.id, userId));

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
