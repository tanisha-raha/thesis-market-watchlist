/**
 * Drives the slice in a real browser: sign up, add, see a price, remove.
 * The service layer is covered by scripts/smoke.ts; this covers the UI.
 *
 * Run: npx tsx scripts/browser-check.ts [baseUrl]
 */
import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:3000";
const email = `browser+${Date.now()}@example.com`;
let failed = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail && ` — ${detail}`}`);
  if (!cond) failed++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

console.log(`\ntarget: ${base}`);

await page.goto(base);
check("unauthenticated visit lands on /login", page.url().endsWith("/login"), page.url());

console.log("\nsign up");
await page.getByRole("button", { name: "Create account" }).first().click();
await page.locator('input[name="email"]').fill(email);
await page.locator('input[name="password"]').fill("hunter2hunter2");
await Promise.all([
  page.waitForURL("**/digest", { timeout: 30_000 }),
  page.getByRole("button", { name: "Create account" }).last().click(),
]);
check("signup lands on /digest", page.url().includes("/digest"), page.url());
check("shows the signed-in email", await page.getByText(email).isVisible());
await page.getByRole("link", { name: "Watchlist" }).click();
await page.waitForURL("**/watchlist");
check("empty state shown", await page.getByText("Nothing on your watchlist yet").isVisible());

console.log("\nadd a symbol");
const symbolInput = page.locator('input[name="symbol"][autocomplete="off"]');
await symbolInput.fill("RELIANCE.NS");
await page.getByRole("button", { name: "Add" }).click();
const removeReliance = page.getByRole("button", { name: "Remove RELIANCE.NS" });
await removeReliance.waitFor({ state: "visible", timeout: 40_000 });
check("symbol appears in the list", await removeReliance.isVisible());

const body = await page.locator("body").innerText();
check("a rupee price is rendered", /₹[\d,]+\.\d{2}/.test(body), body.match(/₹[\d,]+\.\d{2}/)?.[0]);
check("change vs previous close shown", /vs prev close/.test(body));
check("freshness is stated", /just now|min ago|\dh ago|market closed|no quote yet/.test(body),
  body.match(/just now|\d+ min ago|\dh ago|market closed/)?.[0]);
check("disclaimer present", /not an advisory product/.test(body));
check("no advice language", !/\b(buy|sell|hold|target price|recommend)\b/i.test(body));

console.log("\nsymbol detail");
await page.getByRole("link", { name: "RELIANCE.NS" }).click();
await page.waitForURL("**/symbol/RELIANCE.NS", { timeout: 20_000 });
const detail = await page.locator("main").innerText();
check("watchlist symbol opens its detail", /RELIANCE\.NS/.test(detail));
check("detail carries price context", /₹[\d,]+\.\d{2}/.test(detail) && /vs prev close/.test(detail));
check("detail has a truthful no-thesis state", /No thesis recorded/.test(detail));
await page.goBack();
await page.waitForURL("**/watchlist", { timeout: 20_000 });

console.log("\nsearch");
await symbolInput.fill("");
await symbolInput.type("infosys", { delay: 30 });
const suggestion = page.getByRole("button", { name: /INFY\.NS/ });
const gotSuggestions = await suggestion.first().waitFor({ state: "visible", timeout: 15_000 })
  .then(() => true)
  .catch(() => false);
check("search suggests INFY.NS", gotSuggestions);

console.log("\nunresolvable symbol");
await symbolInput.fill("NOTAREALTICKER.NS");
await page.getByRole("button", { name: "Add" }).click();
const unresolvedMessage = page.getByText("We could not resolve NOTAREALTICKER.NS on NSE.");
const rejectedUnresolvable = await unresolvedMessage.waitFor({ state: "visible", timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
check("silently dropped symbol is explicitly rejected", rejectedUnresolvable);

console.log("\nremove");
await symbolInput.fill("");
await removeReliance.click();
await page.getByText("Nothing on your watchlist yet").waitFor({ timeout: 20_000 });
check("removal returns to empty state", true);

console.log("\nsign out");
await page.getByRole("button", { name: "Sign out" }).click();
await page.waitForURL("**/login", { timeout: 20_000 });
check("sign out returns to /login", page.url().endsWith("/login"));
await page.goto(`${base}/watchlist`);
check("watchlist is gated after sign out", page.url().endsWith("/login"), page.url());

check("no uncaught client errors", errors.length === 0, errors.slice(0, 2).join(" | "));

await page.goto(base);
await browser.close();
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
