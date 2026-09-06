import { chromium } from "playwright/test";
const base = (process.argv[2] ?? "http://localhost:3100").replace(/\/$/, "");
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
if (process.env.NAV_BYPASS_SECRET) await p.request.get(base + "/login", { headers: { "x-vercel-protection-bypass": process.env.NAV_BYPASS_SECRET, "x-vercel-set-bypass-cookie": "true" } });
await p.goto(base + "/login");
await p.getByRole("button", { name: "Create account", exact: true }).click();
await p.getByRole("textbox", { name: "Name", exact: true }).fill("Chat Test");
await p.locator('input[name="email"]').fill(`chat13+${Date.now()}@example.com`);
await p.locator('input[name="password"]').fill("chat13-probe-2026");
await p.locator('input[name="confirmPassword"]').fill("chat13-probe-2026");
await p.getByRole("button", { name: "Create account", exact: true }).click();
await p.waitForURL(base + "/", { timeout: 60000 });
await p.goto(base + "/watchlist");
for (const symbol of ["SBILIFE.NS", "RELIANCE.NS"]) {
  await p.getByRole("button", { name: "Add Stock", exact: true }).click();
  await p.locator('input[name="symbol"][autocomplete="off"]').fill(symbol);
  if (symbol === "SBILIFE.NS") {
    await p.getByLabel("Watching for a breakout").check();
    await p.locator('input[name="level"]').fill("1900");
    await p.locator('input[name="note"]').fill("Protection mix should re-rate the book.");
  }
  if (symbol === "RELIANCE.NS") {
    await p.getByLabel("Waiting for a dip").check();
    await p.locator('input[name="low"]').fill("1200"); await p.locator('input[name="high"]').fill("1300");
    await p.locator('input[name="note"]').fill("Only interesting after a retail markdown.");
  }
  await p.getByRole("button", { name: "Add", exact: true }).click();
  await p.getByRole("button", { name: `Remove ${symbol}` }).waitFor({ timeout: 60000 });
}
const convos: string[][] = [
  ["What is a P/E ratio?"], ["Why do interest rates affect stocks?"], ["What is the difference between revenue and profit?"],
  ["Tell me about Apple."], ["Compare Apple and Infosys."], ["What should I look at when comparing two stocks?"],
  ["Why am I watching SBILIFE?"], ["Explain my Reliance thesis."], ["What changed for SBILIFE?"],
  ["Which stock should I invest in?"], ["Should I buy Apple?"],
  ["What is beta?", "Why does it matter?"], ["Compare Apple and Infosys.", "Which one is more volatile?"],
];
let n = 0, errors = 0;
for (const turns of convos) {
  n++;
  await p.goto(base + "/ask");
  await p.evaluate(() => sessionStorage.removeItem("thesis-conversation"));
  await p.goto(base + "/ask");
  console.log(`\n### ${n}`);
  for (const q of turns) {
    await p.getByLabel("Ask THESIS a question").fill(q);
    const wait = p.waitForResponse((r) => r.url().endsWith("/api/ask") && r.request().method() === "POST");
    await p.getByLabel("Ask THESIS a question").press("Enter");
    const j = await (await wait).json();
    console.log(`U: ${q}\nA[${j.category}/${j.source ?? "-"}]: ${String(j.answer).replace(/\s+/g, " ").slice(0, 260)}`);
  }
  errors += await p.locator(".chat-message.error").count();
}
console.log("\nERROR CARDS:", errors);
console.log("LABELS SEEN:", JSON.stringify([...new Set(await p.locator(".chat-message.assistant .eyebrow").allInnerTexts())]));
await b.close();
