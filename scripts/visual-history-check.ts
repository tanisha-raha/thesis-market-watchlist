/** Local-only visual fixture: copy existing demo account evidence, never invent market events. */
import { chromium, expect } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, watchlistItems, theses, thesisEvents } from "@/db/schema";
import { registerUser } from "@/lib/auth";
import { getDigest } from "@/lib/digest";

const base = process.argv[2] ?? "http://localhost:3101";
const output = process.argv[3] ?? "/private/tmp/thesis-history-visual";
const local = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);
if (!local(new URL(base).hostname) || !process.env.DATABASE_URL || !local(new URL(process.env.DATABASE_URL).hostname)) {
  throw new Error("Historical visual fixtures are restricted to a local server and local database.");
}
const [source] = await db.select().from(users).where(eq(users.email, "demo@thesis.app"));
if (!source) throw new Error("An existing seeded demo account is required; this check never seeds market data.");
const email = `visual-history+${Date.now()}@example.com`;
const password = "local-visual-history-2026";
const registered = await registerUser(email, password, "History QA");
if (!registered.ok) throw new Error("Unable to create isolated visual fixture account.");
const fixtureId = registered.userId;
const browser = await chromium.launch();
try {
  // Copy only demo-owned watchlist/thesis records and their exact stored verdicts.
  // No writes to shared quotes/history/change events, or the source user's watermarks.
  await db.transaction(async (tx) => {
    for (const item of await tx.select().from(watchlistItems).where(eq(watchlistItems.userId, source.id))) {
      const [copy] = await tx.insert(watchlistItems).values({ userId: fixtureId, symbol: item.symbol, createdAt: item.createdAt }).returning();
      const [thesis] = await tx.select().from(theses).where(eq(theses.watchlistItemId, item.id));
      if (!thesis) continue;
      const { id: sourceThesisId, ...fields } = thesis;
      const [copiedThesis] = await tx.insert(theses).values({ ...fields, watchlistItemId: copy.id }).returning();
      for (const verdict of await tx.select().from(thesisEvents).where(eq(thesisEvents.thesisId, sourceThesisId))) {
        const { id: _id, ...evidence } = verdict;
        await tx.insert(thesisEvents).values({ ...evidence, thesisId: copiedThesis.id });
      }
    }
  });
  const digest = await getDigest(fixtureId);
  if (!digest.triggers.length || !digest.contradictions.length || !digest.missed.length) throw new Error("Existing history cannot supply all three required visual states.");
  console.log(`Stored fixture: ${digest.triggers.length} triggered, ${digest.contradictions.length} contradicted, ${digest.missed.length} missed`);
  const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
  await page.goto(base + "/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await page.waitForURL(base + "/");
  await page.goto(base + "/digest");
  await expect(page.locator(".top-feed")).toContainText("DEMO REPLAY");
  await expect(page.locator(".digest-timeline > article").first()).toBeVisible();
  await mkdir(output, { recursive: true });
  // Resize the same rendered snapshot: its normal read receipt remains enabled.
  for (const viewport of [{ width: 1536, height: 864 }, { width: 1440, height: 900 }, { width: 1000, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const mode of ["dark", "light"]) {
      await page.evaluate((v) => { localStorage.setItem("thesis-theme", v); window.dispatchEvent(new Event("thesis-theme-change")); }, mode);
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
      await page.screenshot({ path: `${output}/populated-digest-${mode}-${viewport.width}.png`, fullPage: true, animations: "disabled" });
    }
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Digest overflow at ${viewport.width}`);
    console.log(`PASS populated digest ${viewport.width}`);
  }
} finally {
  await browser.close();
  // Only the exact account created above is removed; its dependent fixtures cascade.
  await db.delete(users).where(eq(users.id, fixtureId));
  console.log("Removed isolated local visual account; existing demo and market data preserved.");
}
