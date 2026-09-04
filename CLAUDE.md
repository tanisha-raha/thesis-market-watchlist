# Thesis — working constraints

> A watchlist that remembers *why* you're watching. Full spec in [BRIEF.md](BRIEF.md); this file is
> the subset that must hold on every turn.

## What this product is

A **thesis-monitoring system**, not a price tracker. "Meaningfully changed" is a property of the
*user's relationship with the stock* — their stated reason for watching — not of the market.
Three event kinds a conventional watchlist cannot express: **condition met**, **thesis
contradicted**, **missed event** (fired and reversed while the user was away).

The anomaly engine is infrastructure. The thesis layer is the product.

## Stack — fixed

Next.js (App Router) + TypeScript, single deployable · Postgres (Neon) · Drizzle ORM · Tailwind ·
`yahoo-finance2` for market data · Vercel, with ingestion triggered by external cron hitting a
protected route.

Do not substitute silently. Propose a swap before making it.

## No over-engineering — this is a scored dimension

"Code quality and simplicity **without unnecessary over-engineering**" is one of five judged
dimensions. **No** microservices, Kubernetes, Kafka, GraphQL, message queues, or a time-series
database. Postgres is sufficient at this scale and choosing not to add more is a defensible answer.

Depth goes into the thesis engine and the change engine. Everything else stays boring and obvious.
Cutting a feature to keep the architecture clean is the *correct* trade, not a compromise. If about
to build something not in BRIEF.md, ask first. Push back on requests that add complexity without
earning it.

## Evidence display — never invent a composite

Never render a made-up score ("Attention score: 82/100 — price anomaly 31/35"). A reviewer will ask
where 35 came from and the honest answer is "I made it up." Show real units:

```
TCS  −4.6%
Move = 2.3σ vs 20-day realized volatility
Volume = 1.9× 20-day median
NIFTY = −1.2%
Stock-specific residual = −3.1%

Your condition: "Interested below ₹2,800"
Entered your range 47 minutes ago.
```

Rank internally by a composite if useful; **expose evidence, not arithmetic.**

`explain_json` / `evidence_json` store the **actual inputs at detection time** (z, vol, beta, index
return, which conditions fired). Render from those — never recompute for display. Stats drift, the
numbers stop matching, and that inconsistency is exactly what a reviewer catches.

## No investment advice — hard boundary

Attention infrastructure, not an advisory product. Ethical *and* regulatory (India).

- ❌ Never: "You should sell INFY." / "Good entry point." / any buy, sell, hold, target, or rating.
- ✅ Always: "The condition you asked us to monitor has changed. Here is the evidence."

Every user-facing string is an observation about the user's *own stated condition*. Plain
disclaimer in the footer and the README.

**The AI never decides whether a thesis is valid. Data does.** Theses are structured and
machine-verifiable; triggers and contradictions are evaluated deterministically against market
data. Any LLM output is optional presentation garnish — if the AI call fails, the product works
identically.

## Standing rules

- Ship a working vertical slice and **deploy it** before anything clever. Verify on the deployed
  URL, not just locally. Target submission at hour 50, not hour 71.
- Append to `DECISIONS.md` after each significant decision, without being asked. Two rubric
  dimensions and the whole Q&A are about reasoning.
- Small commits, clear messages — the history gets reviewed.
- Contradiction always requires **≥2 of 3** independent conditions. One noisy signal never fires it.
- Watermarks are per `(user, symbol)`, monotonic: `last_seen_at = GREATEST(last_seen_at, $new)`.
  Digest cutoff is the **completion timestamp of the last fully-committed ingestion batch**, never
  `now()`.
- Theses are only ever evaluated against data from `thesis_created_at` onward. Never fire on history.
- All diffs computed on the adjusted series. On a split, adjust the user's watermark price **and**
  their thesis parameters — and show them it happened; never silently rewrite what they typed.
- Never render stale data as live. Every quote carries freshness metadata and the UI shows it.

## Data-source facts (validated — see reports/phase0.md)

- Yahoo returns **no raw price series**. `close` is already split-adjusted and is *retroactively
  restated* when a split occurs; `adjclose` additionally removes dividends. Persist our own
  immutable as-observed bars at ingestion — that is the only raw record we will ever have.
- `quote(string[])` **silently drops** unknown/delisted symbols — 50 in, 49 out, no error.
  Always reconcile requested against returned.
- Bars can carry a real close with `volume: 0`. Guard volume-ratio signals against divide-by-zero.
- `^CNXFIN` has no history (1 bar). Other NSE sector indices have 500+ bars over 2y.
