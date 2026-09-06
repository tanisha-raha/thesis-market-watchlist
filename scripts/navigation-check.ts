/** Real click timings; no fixture quotes, no fixed sleeps, no credentials recorded. */
import { chromium, expect, type Locator, type Request } from "playwright/test";

const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/$/, "");
const rounds = Number(process.env.NAV_ROUNDS ?? 3);
const enforce = process.env.NAV_ASSERT === "1";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
if (process.env.NAV_BYPASS_SECRET) {
  await page.request.get(base + "/login", { headers: { "x-vercel-protection-bypass": process.env.NAV_BYPASS_SECRET, "x-vercel-set-bypass-cookie": "true" } });
}
// tsx names nested functions in serialized page.evaluate callbacks.
await page.addInitScript("window.__name = (fn) => fn");
const results: object[] = [];
const errors: string[] = [];
const requests: { request: Request; started: number; finished?: number }[] = [];
const cdp = await page.context().newCDPSession(page);
await cdp.send("Network.enable");
const transfers = new Map<string, { url: string; bytes: number; end?: number }>();
cdp.on("Network.requestWillBeSent", (e) => transfers.set(e.requestId, { url: e.request.url, bytes: 0 }));
cdp.on("Network.dataReceived", (e) => { const r = transfers.get(e.requestId); if (r) r.bytes += e.encodedDataLength; });
cdp.on("Network.loadingFinished", (e) => { const r = transfers.get(e.requestId); if (r) { r.end = Date.now(); r.bytes = e.encodedDataLength; } });
page.on("request", (request) => requests.push({ request, started: Date.now() }));
page.on("requestfinished", (request) => { const r = requests.find((x) => x.request === request); if (r) r.finished = Date.now(); });
page.on("pageerror", (e) => { errors.push(e.message); console.error("CLIENT ERROR", e.message); });
const settled = () => expect(page.locator(".is-loading,[data-navigation-loading]")).toHaveCount(0, { timeout: 45000 });
const nav = (path: string) => page.locator(`nav[aria-label="Main navigation"] a[href="${path}"]`);

async function measure(label: string, path: string, link: Locator, ready: string, round: number) {
  console.log(`MEASURE ${round} ${label}`);
  await link.waitFor();
  await page.evaluate(({ path, ready }) => {
    const w = window as typeof window & { navTiming?: { click: number; first?: number; usable?: number; complete?: number } };
    document.addEventListener("click", () => {
      w.navTiming = { click: Date.now() };
      const sample = () => {
        const t = w.navTiming!;
        const destination = location.pathname === path;
        if (destination && (document.querySelector(ready) || document.querySelector("[data-navigation-loading]"))) t.first ??= Date.now();
        if (destination && document.querySelector(ready) && !document.querySelector("[data-navigation-loading]")) t.usable ??= Date.now();
        if (t.usable && !document.querySelector(".is-loading,[data-navigation-loading]")) t.complete ??= Date.now();
        if (!t.complete) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true, capture: true });
  }, { path, ready });
  await link.click();
  await page.waitForURL(base + path, { timeout: 45000 });
  await page.locator(ready).waitFor({ timeout: 45000 });
  await page.waitForFunction(() => !!(window as unknown as { navTiming: { complete?: number } }).navTiming?.complete, undefined, { timeout: 45000 });
  await settled();
  const t = await page.evaluate(() => (window as unknown as { navTiming: { click: number; first: number; usable: number; complete: number } }).navTiming);
  const navigation = requests.filter(({ request, started }) => started >= t.click && new URL(request.url()).pathname === path && request.method() === "GET");
  // Some RSC transports remain open after visible content settles. Report that
  // explicitly rather than hanging on Response.finished() or inventing an EOF.
  const network = await Promise.all(navigation.map(async ({ request, started }) => {
    const response = await request.response();
    const timing = request.timing();
    const transfer = [...transfers.values()].reverse().find((r) => r.url === request.url());
    return { type: request.resourceType(), start: started - t.click, ttfb: Math.round(timing.responseStart), end: transfer?.end ? transfer.end - t.click : null, bytes: transfer?.bytes ?? null, region: response?.headers()["x-vercel-id"]?.split("::").slice(0, 2).join("::") };
  }));
  const complete = t.complete - t.click;
  const result = { round, label, firstUI: t.first - t.click, usable: t.usable - t.click, contentSettled: complete, destinationToSettled: complete - (t.first - t.click), network, actionsInFlightAtClick: requests.filter((r) => r.started < t.click && (!r.finished || r.finished > t.click) && r.request.method() === "POST").length };
  results.push(result); console.log(JSON.stringify(result));
  if (enforce) {
    expect(navigation.every((r) => r.request.resourceType() !== "document"), "internal navigation must not reload the document").toBe(true);
    expect(await page.evaluate(() => (window as unknown as { originalShell: Element }).originalShell === document.querySelector(".terminal")), "authenticated shell remains mounted").toBe(true);
    if (round > 1) expect(result.firstUI, `${label}: warm first destination UI`).toBeLessThan(500);
  }
}

try {
  console.log(`TARGET ${base} VIEWPORT 1536x864 ROUNDS ${rounds}`);
  await page.goto(base + "/login");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Navigation Check");
  await page.locator('input[name="email"]').fill(`navigation+${Date.now()}@example.com`);
  const password = crypto.randomUUID() + "Aa1!";
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL(base + "/", { timeout: 45000 }); await settled();
  await nav("/watchlist").click();
  await page.getByRole("button", { name: "Add Stock", exact: true }).click();
  await page.locator('input[name="symbol"][autocomplete="off"]').fill("INFY.NS");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Remove INFY.NS" }).waitFor({ timeout: 45000 });
  await nav("/").click(); await page.locator(".home-hero").waitFor(); await settled();
  await page.evaluate(() => { (window as unknown as { originalShell: Element | null }).originalShell = document.querySelector(".terminal"); });
  for (let round = 1; round <= rounds; round++) {
    await measure("Home → Watchlist", "/watchlist", nav("/watchlist"), ".watchlist-table", round);
    await measure("Watchlist → Home", "/", nav("/"), ".home-hero", round);
    await measure("Home → Digest", "/digest", nav("/digest"), ".digest-counts", round);
    await measure("Digest → Watchlist", "/watchlist", nav("/watchlist"), ".watchlist-table", round);
    await measure("Watchlist → watched Symbol", "/symbol/INFY.NS", page.getByRole("link", { name: "INFY.NS", exact: true }), ".symbol-heading", round);
    await measure("Symbol → Watchlist", "/watchlist", nav("/watchlist"), ".watchlist-table", round);
    await page.getByLabel("Search companies").fill("BlackRock");
    const result = page.locator(".search-results a, .search-results button", { hasText: "BLK" }).first();
    await result.waitFor({ timeout: 20000 });
    await measure("Search → unwatched Symbol", "/symbol/BLK", result, ".symbol-heading", round);
    await nav("/").click(); await page.locator(".home-hero").waitFor(); await settled();
  }
  console.log("SUMMARY", JSON.stringify(results));
  if (enforce) {
    // Failure injection, separate from timings: a receipt can remain pending
    // while the next destination loads. No arbitrary sleep or relaxed assertion.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/digest/read", async (route) => { await gate; await route.fulfill({ status: 204 }); });
    try {
      const receipt = page.waitForRequest((r) => r.url().endsWith("/api/digest/read"));
      await nav("/digest").click(); await page.locator(".digest-counts").waitFor(); await receipt;
      await nav("/watchlist").click();
      await expect(page.locator(".watchlist-table")).toBeVisible({ timeout: 1500 });
      await page.getByRole("button", { name: "Account menu", exact: true }).click();
      await expect(page.getByRole("region", { name: "Your account" })).toBeVisible();
      await page.keyboard.press("Escape");
      console.log("PASS pending digest receipt does not block navigation or account controls");
    } finally { release(); await page.unrouteAll({ behavior: "wait" }); }

    const badOrigin = await page.request.post(base + "/api/digest/read", { headers: { origin: "https://not-thesis.example" }, data: { cutoff: new Date().toISOString() } });
    expect(badOrigin.status(), "cross-origin receipt rejected").toBe(403);
    const badBody = await page.request.post(base + "/api/digest/read", { data: { cutoff: "invalid" } });
    expect(badBody.status(), "invalid receipt rejected").toBe(400);
    const stranger = await browser.newContext();
    const unauth = await stranger.request.post(base + "/api/digest/read", { data: { cutoff: new Date().toISOString() } });
    expect(unauth.status(), "receipt requires the existing authenticated session").toBe(401);
    await stranger.close();
    console.log("PASS receipt origin, payload and authentication guards");
  }
  expect(errors).toEqual([]);
} finally { await browser.close(); }
