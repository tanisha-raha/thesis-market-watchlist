/**
 * Regenerates the README screenshots from the running application.
 *
 * Committed so the gallery is reproducible rather than a set of images nobody
 * can re-derive: every shot below is the real product against real stored market
 * data, captured from a production build. Nothing is mocked, and no value is
 * typed into the UI by hand.
 *
 * The one fixture is a disposable account: it watches real securities and its
 * read watermark is set back ten days, which is exactly the state of a user who
 * has been away — that is what makes the digest show the events it already
 * detected. The account is deleted afterwards.
 *
 * Run:  npm run build && npx next start -p 3100
 *       npm run screenshots
 */
import { chromium, expect, type Page } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userSymbolReadState, users } from "@/db/schema";
import { registerUser } from "@/lib/auth";
import { addSymbol } from "@/lib/watchlist";
import { createThesis, creationContext } from "@/lib/thesis";

const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/$/, "");
const output = process.argv[3] ?? "docs/screenshots";

/** Real securities across both supported markets, and one with a real thesis. */
const WATCHED = ["INFY.NS", "RELIANCE.NS", "TCS.NS", "AAPL", "BLK"] as const;
/** A security whose stored history the anomaly layer actually classified. */
const PATTERN_SYMBOL = "SBILIFE.NS";
const AWAY_DAYS = 10;

const email = `screenshots+${Date.now()}@example.com`;
const password = "screenshot-fixture-2026";

async function shot(page: Page, name: string) {
  // Never photograph a streaming placeholder.
  await expect(page.locator(".is-loading")).toHaveCount(0, { timeout: 30000 });
  await page.waitForTimeout(400);            // let charts settle, not data load
  await page.screenshot({ path: `${output}/${name}.png`, animations: "disabled" });
  console.log(`  ✓ ${name}`);
}

async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((value) => {
    localStorage.setItem("thesis-theme", value);
    window.dispatchEvent(new Event("thesis-theme-change"));
  }, theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

await mkdir(output, { recursive: true });

const registered = await registerUser(email, password, "Tanisha Raha");
if (!registered.ok) throw new Error(`fixture account: ${registered.error}`);
const userId = registered.userId;

try {
  for (const symbol of [...WATCHED, PATTERN_SYMBOL]) {
    const added = await addSymbol(userId, symbol);
    if (!added.ok) throw new Error(`${symbol}: ${added.error}`);
    if (symbol === "INFY.NS") {
      await createThesis({
        watchlistItemId: added.watchlistItemId,
        type: "price_range",
        params: { low: 1000, high: 1100, context: await creationContext(symbol) },
        note: "Watching for the services demand cycle to turn before I add.",
      });
    }
  }
  // Ten days away: the digest window then contains events THESIS already detected.
  const awayFrom = new Date(Date.now() - AWAY_DAYS * 864e5);
  for (const symbol of [...WATCHED, PATTERN_SYMBOL]) {
    await db.insert(userSymbolReadState).values({ userId, symbol, lastSeenAt: awayFrom })
      .onConflictDoUpdate({ target: [userSymbolReadState.userId, userSymbolReadState.symbol], set: { lastSeenAt: awayFrom } });
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1240 } });
  await page.goto(`${base}/login`);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await page.waitForURL(`${base}/`, { timeout: 40000 });
  await setTheme(page, "dark");

  // 01 — Home: the market brief, both markets on their own clocks.
  await page.goto(`${base}/`);
  await expect(page.locator(".index-card")).toHaveCount(6);
  await shot(page, "01-home");

  // 02 — Watchlist: two markets, two currencies, one list.
  await page.setViewportSize({ width: 1440, height: 820 });
  await page.goto(`${base}/watchlist`);
  await expect(page.locator(".watchlist-table tbody tr")).toHaveCount(WATCHED.length + 1);
  await shot(page, "02-watchlist");

  // 03 — Symbol detail: price history and the user's own reason for watching.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/symbol/INFY.NS`);
  await expect(page.locator(".thesis-card")).toBeVisible();
  await shot(page, "03-symbol-detail");

  // 04 — Market Pattern: the anomaly layer's one claim, plus what it saw.
  await page.goto(`${base}/symbol/${PATTERN_SYMBOL}`);
  const pattern = page.locator(".panel", { hasText: "Market Pattern" }).first();
  await pattern.waitFor({ timeout: 20000 });
  await pattern.screenshot({ path: `${output}/04-market-pattern.png`, animations: "disabled" });
  console.log("  ✓ 04-market-pattern");

  // 05 — Thesis Replay: how the user's own condition behaved historically.
  await page.goto(`${base}/symbol/INFY.NS`);
  const replay = page.locator("#thesis-replay");
  await replay.waitFor({ timeout: 20000 });
  await replay.screenshot({ path: `${output}/05-thesis-replay.png`, animations: "disabled" });
  console.log("  ✓ 05-thesis-replay");

  // 06 — Recorded Evidence: the figures captured when an event fired.
  const evidence = page.locator(".panel", { hasText: "Recorded Evidence" }).first();
  await page.goto(`${base}/symbol/${PATTERN_SYMBOL}`);
  await evidence.waitFor({ timeout: 20000 });
  await evidence.screenshot({ path: `${output}/06-recorded-evidence.png`, animations: "disabled" });
  console.log("  ✓ 06-recorded-evidence");

  // 07 — Digest: what happened while this account was away.
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`${base}/digest`);
  await expect(page.locator(".digest-counts")).toBeVisible();
  await shot(page, "07-digest");

  // 08 — Ask THESIS: grounded explanation, and the advice boundary.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/ask?symbol=INFY.NS`);
  for (const question of ["What is my thesis for INFY?", "Should I buy INFY?"]) {
    const response = page.waitForResponse((r) => r.url().endsWith("/api/ask") && r.request().method() === "POST");
    await page.getByLabel("Ask THESIS a question").fill(question);
    await page.getByLabel("Ask THESIS a question").press("Enter");
    await response;
  }
  await expect(page.locator(".chat-message")).toHaveCount(4);
  await shot(page, "08-ask-thesis");

  // 09 — the same product in light mode.
  await page.setViewportSize({ width: 1440, height: 1240 });
  await page.goto(`${base}/`);
  await setTheme(page, "light");
  await page.goto(`${base}/`);
  await expect(page.locator(".index-card")).toHaveCount(6);
  await shot(page, "09-light-mode");

  await browser.close();
  console.log(`\nScreenshots written to ${output}`);
} finally {
  // The fixture account exists only for the capture; its rows cascade away.
  await db.delete(users).where(eq(users.id, userId));
  console.log("Fixture account removed. Shared market data untouched.");
}
