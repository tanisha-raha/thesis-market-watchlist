/** Real browser layout and interaction checks; screenshots are QA artifacts only. */
import { chromium, expect, type Page } from "playwright/test";
import { mkdir } from "node:fs/promises";

const base = process.argv[2] ?? "http://localhost:3100";
const output = process.argv[3] ?? "/private/tmp/thesis-visual-local";
const demo = process.argv.includes("--demo");
if (demo && !/localhost|127\.0\.0\.1/.test(base)) throw new Error("Demo credentials are local-only.");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir(output, { recursive: true });
const nav = (p: Page) => p.getByRole("navigation", { name: "Main navigation" });
async function screenshot(name: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: !name.startsWith("chat-drawer") && !name.startsWith("add-stock"), animations: "disabled" });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  if (overflow) {
    console.log(await page.evaluate(() => [...document.querySelectorAll("body *")].map((el) => ({ tag: el.tagName, class: el.className, x: el.getBoundingClientRect().x, right: el.getBoundingClientRect().right })).filter((el) => el.right > innerWidth + 1).slice(0, 15)));
    throw new Error(`Document overflows at ${name}`);
  }
  console.log(`PASS layout ${name}`);
}
async function ask(question: string) {
  await page.getByLabel("Ask THESIS a question").fill(question);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/ask") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const result = await response;
  if (!result.ok()) throw new Error(`Ask THESIS failed (${result.status()})`);
  const reply = await result.json();
  await expect(page.getByRole("log").getByText(reply.answer, { exact: true })).toBeVisible();
  return reply.answer as string;
}
try {
  await page.goto(base);
  if (demo) {
    await page.locator('input[name="email"]').fill("demo@thesis.app");
    await page.locator('input[name="password"]').fill("demo-account-2026");
    await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  } else {
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.locator('input[name="email"]').fill(`visual+${Date.now()}@example.com`);
    await page.locator('input[name="password"]').fill("visual-check-2026");
    await page.getByRole("button", { name: "Create account" }).last().click();
  }
  await page.waitForURL("**/digest", { timeout: 30000 });
  await expect(page.getByTestId("desktop-chat")).toBeVisible();
  if (!demo) {
    await screenshot("empty-digest-1536");
    await nav(page).getByRole("link", { name: "Home", exact: true }).click();
    await page.waitForURL(base + "/");
    await screenshot("empty-home-1536");
    await nav(page).getByRole("link", { name: "Watchlist", exact: true }).click();
    await page.waitForURL("**/watchlist");
    await screenshot("empty-watchlist-1536");
    // Global search is a real entry into the existing add + optional-thesis flow.
    await page.getByLabel("Search companies").fill("infosys");
    await page.locator(".search-results").getByRole("button", { name: /INFY.NS/ }).click();
    await expect(page.getByRole("dialog", { name: "Add stock", exact: true })).toBeVisible();
    await page.getByLabel("Waiting for a dip").check();
    await page.locator('input[name="low"]').fill("1000");
    await page.locator('input[name="high"]').fill("1100");
    await page.locator('input[name="note"]').fill("I am watching the recorded range. This longer note stays exactly as written, wraps within the thesis card, and is never interpreted by THESIS.");
    await screenshot("add-stock-1536");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: "Remove INFY.NS" }).waitFor({ timeout: 40000 });
    await expect(page.getByRole("dialog", { name: "Add stock", exact: true })).not.toBeVisible();
    for (const symbol of ["RELIANCE.NS", "TCS.NS"]) {
      await page.getByRole("button", { name: "Add Stock", exact: true }).click();
      await page.locator('input[name="symbol"][autocomplete="off"]').fill(symbol);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("button", { name: `Remove ${symbol}` }).waitFor({ timeout: 40000 });
      await expect(page.getByRole("dialog", { name: "Add stock", exact: true })).not.toBeVisible();
    }
  }
  const detailSymbol = demo ? "TRENT.NS" : "INFY.NS";
  for (const viewport of [{ width: 1536, height: 864 }, { width: 1440, height: 900 }, { width: 1000, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const [name, route] of [["home", "/"], ["watchlist", "/watchlist"], ["symbol", `/symbol/${detailSymbol}`], ["digest", "/digest"]]) {
      await page.goto(base + route);
      await expect(page.locator(".terminal")).toBeVisible();
      if (viewport.width >= 1280) {
        await expect(page.getByTestId("desktop-chat")).toBeVisible();
        await nav(page).getByRole("button", { name: /Ask THESIS/ }).click();
        await expect(page.getByLabel("Ask THESIS a question")).toBeFocused();
        await page.getByLabel("Search companies").focus();
        await nav(page).getByRole("button", { name: /Ask THESIS/ }).click();
        await expect(page.getByLabel("Ask THESIS a question")).toBeFocused();
      } else {
        if (viewport.width < 768) await page.getByRole("button", { name: "Open navigation" }).click();
        await nav(page).getByRole("button", { name: /Ask THESIS/ }).click();
        await expect(page.getByRole("dialog", { name: "Ask THESIS", exact: true })).toBeVisible();
        if (name === "home") await screenshot(`chat-drawer-${viewport.width}`);
        await page.getByRole("button", { name: "Close Ask THESIS" }).click();
      }
      await screenshot(`${name}-${viewport.width}`);
      if (name === "watchlist" && viewport.width < 768) {
        await page.locator(".table-scroll").evaluate((el) => { el.scrollLeft = el.scrollWidth; });
        const action = await page.getByRole("button", { name: /^Remove / }).first().boundingBox();
        if (!action || action.x < 0 || action.x + action.width > viewport.width) throw new Error("Mobile table actions are not reachable by horizontal scroll");
        await screenshot("watchlist-scrolled-390");
      }
    }
  }
  await page.setViewportSize({ width: 1536, height: 864 });
  await page.goto(`${base}/symbol/${detailSymbol}`);
  await expect(page.getByTestId("desktop-chat")).toBeVisible();
  if (!demo) {
    const thesisReply = await ask("What is my thesis for INFY?");
    if (!thesisReply.includes("INFY.NS") || !thesisReply.includes("₹1,000.00 to ₹1,100.00")) throw new Error("INFY thesis context missing");
    const evidenceReply = await ask("Explain the latest INFY evidence.");
    if (!evidenceReply.includes("INFY.NS") || !/was marked for|no stored detected event/.test(evidenceReply)) throw new Error("Stored event evidence or explicit absence missing from explanation");
    const advisory = await ask("Should I buy INFY?");
    if (!advisory.includes("can’t recommend")) throw new Error("Advisory boundary failed");
    console.log("PASS INFY thesis, evidence question, advisory boundary");
  }
  await ask("What changed while I was away?");
  await screenshot("chat-conversation-1536");
  // Simulate only the browser's transport failing. This does not touch the API,
  // provider, database, or engine and cannot inject fabricated financial values.
  await page.route("**/api/ask", (route) => route.abort("failed"));
  await page.getByLabel("Ask THESIS a question").fill("What changed?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Ask THESIS is temporarily unavailable. Please try again/)).toBeVisible();
  await screenshot("chat-failure-1536");
  await page.unroute("**/api/ask");
  await nav(page).getByRole("link", { name: "Watchlist", exact: true }).click();
  await page.waitForURL("**/watchlist");
  await expect(page.getByRole("heading", { name: "My Watchlist" })).toBeVisible();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`PASS visual QA, responsive chat, isolated chat failure; screenshots: ${output}`);
} finally { await browser.close(); }
