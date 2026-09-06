/** Real browser visual matrix. Screenshots stay outside the repository. */
import { chromium, expect } from "playwright/test";
import { mkdir } from "node:fs/promises";
const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/$/, "");
const output = process.argv[3] ?? "/private/tmp/thesis-final-visual";
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const sizes = [{ width: 1536, height: 864 }, { width: 1440, height: 900 }, { width: 1000, height: 800 }, { width: 390, height: 844 }];
await mkdir(output, { recursive: true });
async function shot(name: string) {
  // Streamed sections must have arrived: a screenshot of a placeholder is not a
  // screenshot of the product.
  await expect(page.locator(".is-loading")).toHaveCount(0, { timeout: 30000 });
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: "disabled" });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Overflow: ${name}`);
  console.log(`PASS layout ${name}`);
}
async function theme(value: string) {
  await page.evaluate((v) => { localStorage.setItem("thesis-theme", v); window.dispatchEvent(new Event("thesis-theme-change")); }, value);
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
}
try {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.goto(base + "/login");
    for (const mode of ["dark", "light"]) {
      await theme(mode); await shot(`signin-${mode}-${size.width}`);
      await page.getByRole("button", { name: "Create account", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
      await shot(`signup-${mode}-${size.width}`);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
  }
  await page.setViewportSize(sizes[0]);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Tanisha Visual");
  await page.locator('input[name="email"]').fill(`visual+${Date.now()}@example.com`);
  await page.locator('input[name="password"]').fill("visual-check-2026");
  await page.locator('input[name="confirmPassword"]').fill("visual-check-2026");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL(base + "/", { timeout: 40000 });
  await page.goto(base + "/watchlist");
  // A deliberately mixed watchlist: two markets, two currencies, two clocks —
  // the case every screen has to look coherent in.
  for (const symbol of ["INFY.NS", "RELIANCE.NS", "TCS.NS", "AAPL", "BLK"]) {
    await page.getByRole("button", { name: "Add Stock", exact: true }).click();
    await page.locator('input[name="symbol"][autocomplete="off"]').fill(symbol);
    if (symbol === "INFY.NS") {
      await page.getByLabel("Waiting for a dip").check();
      await page.locator('input[name="low"]').fill("1000"); await page.locator('input[name="high"]').fill("1100");
      await page.locator('input[name="note"]').fill("My original thesis note, preserved exactly. This is context I wrote, not a machine-interpreted investment view.");
    }
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("button", { name: `Remove ${symbol}` }).waitFor({ timeout: 40000 });
  }
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const mode of ["dark", "light"]) {
      await theme(mode);
      for (const [name, path] of [["home", "/"], ["watchlist", "/watchlist"], ["digest", "/digest"], ["symbol", "/symbol/INFY.NS"], ["symbol-us", "/symbol/BLK"], ["company", "/symbol/MSFT"], ["ask", "/ask?symbol=INFY.NS"]]) {
        await page.goto(base + path); await expect(page.locator(".terminal")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
        if (name !== "ask") await expect(page.locator(".chat-panel")).toHaveCount(0);
        if (name === "home") {
          await expect(page.locator(".watchlist-table")).toHaveCount(0);
          await expect(page.locator(".index-card")).toHaveCount(6);
          const heights = await page.locator(".index-card").evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().height)));
          // Six cards, one height: the alignment is asserted, not eyeballed.
          if (new Set(heights).size !== 1) throw new Error(`Index cards misaligned: ${heights.join(",")}`);
        }
        if (name === "symbol" || name === "symbol-us") await expect(page.locator("#thesis-replay")).toBeVisible();
        // Recorded Evidence: tiles or a truthful empty state, never a wall of equal rows.
        if (name.startsWith("symbol") || name === "company") {
          const evidence = page.locator(".panel", { hasText: "Recorded Evidence" }).first();
          await expect(evidence).toBeVisible();
          const text = await evidence.innerText();
          if (/\^NSEI|\^GSPC|WATCHING/.test(text)) throw new Error(`Recorded Evidence leaked a ticker or thesis status: ${name}`);
          if (!/Captured at detection/.test(text)) throw new Error(`Recorded Evidence lost its detection-time guarantee: ${name}`);
        }
        if (name === "symbol-us") {
          const heading = await page.locator(".symbol-heading").innerText();
          if (heading.includes("₹") || heading.includes("IST")) throw new Error("US security rendered with Indian units");
        }
        // A company nobody here watches: market data yes, personal claims no.
        if (name === "company") {
          const body = await page.locator("body").innerText();
          if (!/Add to Watchlist/.test(body)) throw new Error("Unwatched company is missing its add call to action");
          if (!/Add this company to your watchlist/.test(body)) throw new Error("Unwatched company is missing its truthful thesis state");
          if (/TRIGGERED|CONTRADICTED|Keep watching/.test(body)) throw new Error("Unwatched company fabricated a thesis state");
          if (await page.locator("#thesis-replay").count() !== 0) throw new Error("Replay shown for a company with no thesis");
        }
        if (name === "watchlist") {
          const company = page.locator(".company-cell p").filter({ hasText: "Tata Consultancy" });
          await expect(company).toBeVisible();
          if (await company.evaluate((el) => el.scrollWidth > el.clientWidth + 1)) throw new Error("Company name clipped");
          const table = await page.locator(".watchlist-table").innerText();
          if (!/₹[\d,]+\.\d{2}/.test(table) || !/\$[\d,]+\.\d{2}/.test(table)) throw new Error("Mixed-currency watchlist did not render both currencies");
        }
        await shot(`${name}-${mode}-${size.width}`);
        if (name === "home") {
          await page.getByRole("button", { name: "Account menu" }).click(); await shot(`account-${mode}-${size.width}`); await page.keyboard.press("Escape");
        }
        if (name === "watchlist") {
          await page.getByRole("button", { name: "Add Stock", exact: true }).click(); await shot(`add-${mode}-${size.width}`); await page.getByRole("button", { name: "Close Add Stock" }).click();
        }
      }
    }
  }
  await page.route("**/api/ask", (route) => route.abort("failed"));
  await page.getByLabel("Ask THESIS a question").fill("What changed?"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Ask THESIS is temporarily unavailable. Please try again/)).toBeVisible();
  await shot("chat-transport-failure"); await page.unroute("**/api/ask");
  await page.goto(base + "/watchlist"); await expect(page.getByRole("button", { name: "Remove INFY.NS" })).toBeVisible();
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`PASS visual matrix; ${output}`);
} finally { await browser.close(); }
