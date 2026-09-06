/** Real authenticated product journey. Never substitutes financial fixtures for provider data. */
import { chromium, expect } from "playwright/test";
const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/$/, "");
const email = `browser+${Date.now()}@example.com`, password = "hunter2hunter2";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1536, height: 864 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
let checks = 0;
function check(label: string, value: boolean) { if (!value) throw new Error(label); checks++; console.log(`PASS ${label}`); }
async function visit(path: string) { await page.goto(base + path); await expect(page.locator(".terminal")).toBeVisible(); await settled(); }
/** Streamed sections render placeholders first; assert on the real thing. */
async function settled() { await expect(page.locator(".is-loading,[data-navigation-loading]")).toHaveCount(0, { timeout: 30000 }); }
async function account() { await page.getByRole("button", { name: "Account menu", exact: true }).click(); await expect(page.getByRole("region", { name: "Your account" })).toBeVisible(); }
async function logout() { await account(); await page.getByRole("button", { name: "Sign out", exact: true }).click(); await page.waitForURL("**/login"); }
async function ask(question: string) {
  await page.getByLabel("Ask THESIS a question").fill(question);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/ask") && r.request().method() === "POST");
  await page.getByLabel("Ask THESIS a question").press("Enter");
  const result = await response;
  check(`Ask request succeeds: ${question}`, result.ok());
  const payload = await result.json();
  await expect(page.getByRole("log").getByText(payload.answer, { exact: true }).last()).toBeVisible();
  return payload;
}
try {
  console.log(`Target: ${base}`);
  await page.goto(base);
  check("unauthenticated redirect", page.url().endsWith("/login"));
  check("sign-in asks only for email and password", await page.locator('input[name="displayName"]').count() === 0);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Tanisha Test");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password + "x");
  check("signup refuses mismatched passwords before submitting", await page.getByRole("button", { name: "Create account", exact: true }).isDisabled());
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await page.waitForURL(base + "/", { timeout: 40000 });
  await expect(page.getByRole("heading", { name: /Tanisha/ })).toBeVisible();
  await settled();
  check("signup lands on a Home greeting that uses the stored first name",
    /Good (morning|afternoon|evening), Tanisha/.test(await page.locator(".home-hero").innerText()));
  for (const name of ["NIFTY 50", "SENSEX", "NIFTY BANK", "S&P 500", "NASDAQ Composite", "Dow Jones"]) {
    await expect(page.locator(".index-card").getByText(name, { exact: true })).toBeVisible();
  }
  check("Home shows three Indian and three US index cards", await page.locator(".index-card").count() === 6);
  const regionHeadings = (await page.locator(".pulse-region-heading").allInnerTexts()).join("|").toUpperCase();
  check("both markets are labelled as their own region", regionHeadings.includes("INDIA") && regionHeadings.includes("UNITED STATES"));
  const pulse = await page.locator(".market-pulse").innerText();
  check("no single global market state is claimed", /INDIA (OPEN|CLOSED|PRE-MARKET|AFTER HOURS)|Session state unavailable/.test(pulse) && !/^MARKET CLOSED$/m.test(pulse));
  const cardHeights = await page.locator(".index-card").evaluateAll((cards) => cards.map((c) => Math.round(c.getBoundingClientRect().height)));
  check("all six index cards share one height", new Set(cardHeights).size === 1);
  check("every index card resolves a chart or says why it cannot", await page.locator(".index-card .price-chart, .index-card .index-no-history").count() === 6);
  await expect(page.getByText("YOUR THESIS", { exact: true })).toBeVisible();
  check("Your THESIS strip shows three deliberate metrics", await page.locator(".thesis-strip-metrics > div").count() === 3);
  check("Home has no stock rows, full digest or permanent chatbot", await page.locator(".watchlist-table,.chat-panel,.symbol-events").count() === 0);
  await expect(page.getByRole("heading", { name: "Market Briefing", exact: true })).toBeVisible();
  const links = await page.locator(".news-item").evaluateAll((items) => items.map((a) => ({ href: (a as HTMLAnchorElement).href, source: a.querySelector("p")?.textContent })));
  check("news has real HTTPS links and source/time or truthful unavailable state", links.length ? links.every((a) => a.href.startsWith("https://") && a.source?.includes("IST")) : await page.getByText("Market briefing is unavailable right now.").isVisible());
  const identity = await page.getByRole("button", { name: "Account menu" }).innerText();
  check("the account control shows the stored name, never the email", identity.includes("Tanisha Test") && !identity.includes(email));
  check("the avatar initial comes from the name", identity.trim().startsWith("T"));
  await account();
  await expect(page.locator(".account-profile").getByText("Tanisha Test", { exact: true })).toBeVisible();
  await expect(page.locator(".account-profile").getByText(email, { exact: true })).toBeVisible();
  check("the dropdown makes the name primary and the email secondary",
    (await page.locator(".account-profile strong").innerText()) === "Tanisha Test"
    && (await page.locator(".account-profile p").innerText()) === email);
  check("appearance offers exactly Light and Dark", await page.locator('input[name="appearance"]').count() === 2 && await page.getByRole("radio", { name: "System", exact: true }).count() === 0);
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.keyboard.press("Escape");
  await expect(page.locator("#account-dropdown")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeFocused();
  check("theme switches and Escape closes with focus restored", true);
  await account(); await page.getByRole("heading", { name: /Tanisha/ }).click();
  check("click outside closes account menu", !await page.locator("#account-dropdown").isVisible());
  await page.reload(); await settled(); await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  check("theme and session persist after reload", page.url() === base + "/");
  await account(); await page.getByRole("radio", { name: "Dark", exact: true }).check(); await page.keyboard.press("Escape");
  check("sidebar contains only primary navigation, not Logout", !/Logout|Sign out/.test(await page.locator(".app-sidebar").innerText()));
  await visit("/digest"); check("new empty-user Digest loads", !(await page.locator("body").innerText()).includes("Application error"));
  await visit("/ask");
  const empty = await ask("What changed while I was away?");
  check("THESIS data question is grounded", empty.category === "THESIS DATA" && /no new detected changes|THESIS found/.test(empty.answer));
  const general = await ask("What is a P/E ratio?");
  check("a general finance question is answered, with or without a configured model",
    general.category === "GENERAL" && /earnings/i.test(general.answer) && !/aren’t connected|not connected/i.test(general.answer));
  console.log(`GENERAL SOURCE: ${general.source ?? "unknown"}`);
  for (const [question, expect] of [["What is volatility?", /standard deviation/i], ["What does beta mean?", /index/i], ["What is a breakout?", /volume/i]] as [string, RegExp][]) {
    const reply = await ask(question);
    check(`general finance answer is useful: ${question}`, reply.category === "GENERAL" && expect.test(reply.answer) && reply.answer.length > 120);
  }
  for (const question of ["Should I buy Apple?", "Will SBILIFE go up tomorrow?"]) {
    const refusal = await ask(question);
    check(`advisory prompt is refused: ${question}`, refusal.category === "NON-ADVISORY" && /can’t choose an investment/.test(refusal.answer));
  }
  const advice = await ask("Which stock should I invest in?");
  check("advice boundary offers helpful comparison instead", /can’t choose an investment/.test(advice.answer) && /compare companies/.test(advice.answer));
  await page.getByLabel("Ask THESIS a question").fill("First line"); await page.getByLabel("Ask THESIS a question").press("Shift+Enter");
  check("Shift+Enter keeps multiline input", (await page.getByLabel("Ask THESIS a question").inputValue()).includes("\n"));
  await visit("/watchlist"); await expect(page.getByText("Nothing on your watchlist yet.")).toBeVisible();
  check("watchlist empty state", true);
  await page.getByRole("button", { name: "Add Stock", exact: true }).click();
  const symbolInput = page.locator('input[name="symbol"][autocomplete="off"]');
  await symbolInput.fill("RELIANCE.NS"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Remove RELIANCE.NS" }).waitFor({ timeout: 40000 });
  const body = await page.locator("body").innerText();
  check("valid quote renders rupee price", /₹[\d,]+\.\d{2}/.test(body));
  check("previous-close change visible", /vs prev close/.test(body));
  check("exchange/freshness stated", await page.locator(".watchlist-table .freshness").count() > 0);
  check("disclaimer and no advice language", /not an advisory product/.test(body) && !/\b(buy|sell|hold|target price|recommend)\b/i.test(body));
  await page.getByRole("link", { name: "RELIANCE.NS", exact: true }).click();
  await page.waitForURL("**/symbol/RELIANCE.NS");
  check("symbol detail quote and no-thesis state", /₹[\d,]+\.\d{2}/.test(await page.locator(".symbol-price").innerText()) && await page.getByText("No thesis recorded").isVisible());
  await expect(page.getByText("Add a structured condition to use Thesis Replay.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask THESIS about this stock" })).toBeVisible();
  await visit("/watchlist"); await page.getByRole("button", { name: "Add Stock", exact: true }).click();
  await symbolInput.fill("infosys");
  await page.getByRole("button", { name: /INFY\.NS/ }).first().click({ timeout: 15000 });
  check("company search reaches the NSE listing", true);
  await page.getByLabel("Waiting for a dip").check();
  await page.locator('input[name="low"]').fill("1000"); await page.locator('input[name="high"]').fill("1100");
  const note = "Browser check: my note stays exactly as written.";
  await page.locator('input[name="note"]').fill(note);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Remove INFY.NS" }).waitFor({ timeout: 40000 });
  await page.getByRole("link", { name: "INFY.NS", exact: true }).click(); await page.waitForURL("**/symbol/INFY.NS");
  await expect(page.getByText(`“${note}”`)).toBeVisible();
  check("exact free-text note preserved on analytical surface", true);
  await expect(page.getByRole("heading", { name: "THESIS Replay", exact: true })).toBeVisible();
  check("Replay renders observed result or explicit insufficient history", /Observed occurrences|Not enough observed history/.test(await page.locator("#thesis-replay").innerText()));

  /* ---- recorded evidence: one event, its own stored figures --------------- */
  const recorded = page.locator(".panel", { hasText: "Recorded Evidence" }).first();
  await recorded.waitFor({ timeout: 20000 });
  const recordedText = await recorded.innerText();
  check("Recorded Evidence names the event it belongs to", /DETECTED|RESOLVED/.test(recordedText) && /IST|EDT|EST|UTC/.test(recordedText));
  check("Recorded Evidence leads with tiles rather than a table of equals", await recorded.locator(".evidence-tile").count() >= 1);
  check("Recorded Evidence states that values are detection-time values", /Captured at detection/.test(recordedText));
  check("Recorded Evidence shows no provider ticker as a label and no thesis status",
    !/\^NSEI|\^GSPC/.test(recordedText) && !/WATCHING|STILL VALID/.test(recordedText));
  check("Recorded Evidence stays separate from the anomaly layer", !/UNUSUAL PATTERN|anomaly/i.test(recordedText));

  /* ---- the optional anomaly layer, kept in its place ---------------------- */
  const pattern = page.locator(".panel", { hasText: "Market Pattern" }).first();
  await pattern.waitFor({ timeout: 20000 });
  const patternText = await pattern.innerText();
  check("Market Pattern states a category, not a score", /UNUSUAL PATTERN|TYPICAL/.test(patternText) && !/\bscore\b|AI |confidence|probability|\/100/i.test(patternText));
  check("Market Pattern separates the model's claim from the evidence it saw",
    /context, not causal attributions/.test(patternText) && /Secondary evidence/.test(patternText));
  check("the anomaly layer never speaks in advice", !/\b(buy|sell|hold|price target|forecast|predict)\b/i.test(patternText));
  check("stored evidence is attributed to a model version and training window", /iforest-/.test(patternText) && /fitted on \d+ observed sessions/.test(patternText));
  await page.getByRole("link", { name: "Ask THESIS about this stock" }).click(); await page.waitForURL("**/ask?symbol=INFY.NS");
  const thesis = await ask("What is my thesis for INFY?");
  check("own structured thesis and exact note ground the answer", thesis.answer.includes("₹1,000.00 to ₹1,100.00") && thesis.answer.includes(note));
  const evidence = await ask("Explain the latest INFY evidence.");
  check("stored evidence or honest absence", /no stored detected event|was marked for .* at /.test(evidence.answer));
  check("unwatched symbol cannot widen context", (await ask("Explain NOTWATCHEDCHECK.NS event")).answer.includes("not on your watchlist"));
  const priorMessages = await page.locator(".chat-message").count(); await page.reload();
  await expect(page.locator(".chat-message")).toHaveCount(priorMessages);
  check("conversation persists during the same user session", true);
  /* ---- search is discovery: inspect a company before watching it ----------- */
  const search = page.getByLabel("Search companies");
  await search.fill("BlackRock");
  const blk = page.locator(".search-results a", { hasText: "BLK" }).first();
  await blk.waitFor({ timeout: 20000 });
  check("global search returns BlackRock on NYSE, not an NSE-only message", /NYSE/.test(await blk.innerText()) && !/No NSE symbols found/.test(await page.locator(".search-results").innerText()));
  check("search results offer navigation, not an add shortcut", /View/.test(await blk.innerText()) && !/\bAdd\b/.test(await blk.innerText()));
  await blk.click();
  await page.waitForURL("**/symbol/BLK", { timeout: 30000 });
  await settled();
  await expect(page.locator(".symbol-heading")).toBeVisible();
  check("selecting a company opens its detail page without adding it", !(await page.locator(".terminal").innerText()).includes("In watchlist"));
  const unwatched = await page.locator("body").innerText();
  check("an unwatched company still shows real market data", /\$[\d,]+\.\d{2}/.test(unwatched) && /NYSE/.test(unwatched) && /Previous close/.test(unwatched));
  check("an unwatched company has a real chart or a truthful unavailable state",
    await page.locator(".chart-ranges button").count() > 0 || /Price history temporarily unavailable|Not enough observed history/.test(unwatched));
  check("no thesis, status or evidence is fabricated for an unwatched company",
    /Add this company to your watchlist to define why you’re watching it\./.test(unwatched)
    && /No personal timeline for a company you don’t watch/.test(unwatched)
    && !/TRIGGERED|CONTRADICTED|STILL VALID/.test(unwatched));
  for (const [query, expected, exchange] of [["Apple", "AAPL", "NASDAQ"], ["Infosys", "INFY.NS", "NSE"]] as const) {
    await search.fill(query);
    const row = page.locator(".search-results a", { hasText: expected }).first();
    await row.waitFor({ timeout: 20000 });
    check(`searching ${query} reaches ${expected} on ${exchange}`, new RegExp(exchange).test(await row.innerText()));
    await row.click();
    await page.waitForURL(`**/symbol/${encodeURIComponent(expected)}`, { timeout: 30000 });
    await settled();
    await expect(page.locator(".symbol-heading")).toBeVisible();
    check(`${expected} detail opens without being watched first`, (await page.locator(".symbol-heading").innerText()).includes(exchange));
  }

  /* ---- and adding starts from that page, through the existing flow -------- */
  await page.goto(base + "/symbol/BLK");
  await page.getByRole("button", { name: "Add to Watchlist" }).first().click();
  await page.getByLabel("Waiting for a dip").waitFor({ timeout: 20000 });
  check("Add to Watchlist opens the existing add flow with the company filled in", (await symbolInput.inputValue()) === "BLK");
  await page.getByLabel("Waiting for a dip").check();
  await page.locator('input[name="low"]').fill("1000"); await page.locator('input[name="high"]').fill("1200");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("In watchlist")).toBeVisible({ timeout: 40000 });
  check("the detail page reflects being watched, with its thesis", /\$1,000\.00 – \$1,200\.00/.test(await page.locator(".thesis-card").innerText()));
  await visit("/watchlist");
  await page.getByRole("button", { name: "Remove BLK" }).waitFor({ timeout: 40000 });
  const mixedTable = await page.locator(".watchlist-table").innerText();
  check("one watchlist holds both currencies, each in its own units", /\$[\d,]+\.\d{2}/.test(mixedTable) && /₹[\d,]+\.\d{2}/.test(mixedTable));
  check("each row states its own exchange and market", /NYSE · US/.test(mixedTable) && /NSE · India/.test(mixedTable));
  await page.getByRole("link", { name: "BLK", exact: true }).click(); await page.waitForURL("**/symbol/BLK");
  const usDetail = await page.locator(".symbol-heading").innerText();
  check("US symbol detail states NYSE, US and USD", /NYSE/.test(usDetail) && /USD/.test(usDetail) && /\$[\d,]+\.\d{2}/.test(usDetail));
  check("a US security is never priced or timestamped as Indian", !usDetail.includes("₹") && !usDetail.includes("IST"));
  check("US thesis condition is stored and read back in dollars", /\$1,000\.00 – \$1,200\.00/.test(await page.locator(".thesis-card").innerText()));
  check("US replay is either observed or truthfully insufficient", /Observed occurrences|Not enough observed history|Replay is unavailable/.test(await page.locator("#thesis-replay").innerText()));
  const beta = await page.locator("body").innerText();
  check("a US security is never measured against NIFTY", !/vs \^NSEI/.test(beta));
  await page.goto(base + "/symbol/KO");
  check("a company THESIS does not monitor shows no anomaly section at all",
    await page.locator(".panel", { hasText: "Market Pattern" }).count() === 0);
  await page.goto(base + "/symbol/BLK");
  await page.getByRole("link", { name: "Ask THESIS about this stock" }).click(); await page.waitForURL("**/ask?symbol=BLK");
  const usAsk = await ask("What is my thesis for BLK?");
  check("Ask THESIS answers a US security in its own currency", usAsk.answer.includes("$1,000.00") && !usAsk.answer.includes("₹"));

  await visit("/digest"); await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Ask THESIS" })).toBeVisible();
  await logout();
  await page.goto(base + "/watchlist"); check("auth gating after logout", page.url().endsWith("/login"));
  check("Ask endpoint is gated", (await page.request.post(base + "/api/ask", { data: { question: "What changed?" } })).status() === 401);
  await page.locator('input[name="email"]').fill(email); await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.waitForURL(base + "/", { timeout: 40000 });
  await visit("/watchlist");
  check("watchlist persists after login", await page.getByRole("button", { name: "Remove INFY.NS" }).isVisible() && await page.getByRole("button", { name: "Remove RELIANCE.NS" }).isVisible());
  await page.getByRole("button", { name: "Add Stock", exact: true }).click(); await symbolInput.fill("NOTAREALTICKER.NS"); await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("We could not resolve NOTAREALTICKER.NS with our market data provider.")).toBeVisible({ timeout: 20000 });
  check("silent provider omission explicitly rejected", true); await page.getByRole("button", { name: "Close Add Stock" }).click();
  for (const symbol of ["RELIANCE.NS", "INFY.NS", "BLK"]) { await page.getByRole("button", { name: `Remove ${symbol}` }).click(); await expect(page.getByRole("button", { name: `Remove ${symbol}` })).toHaveCount(0); }
  await expect(page.getByText("Nothing on your watchlist yet.")).toBeVisible(); check("remove restores empty state", true);
  await logout(); check("sign out returns to login", page.url().endsWith("/login"));
  check("no uncaught client errors", errors.length === 0);
  console.log(`PASS — ${checks} browser checks`);
} finally { await browser.close(); }
