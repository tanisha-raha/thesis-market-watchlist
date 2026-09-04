# Thesis — Project Brief

> A watchlist that remembers *why* you're watching.

Save this file as `BRIEF.md` in the project root. First message to Claude Code:
> Read BRIEF.md and follow it. Start with Phase 0 and report back before writing any app code. Also distill a short CLAUDE.md with the constraints you need on every turn.

---

## The problem we were given

72-hour solo hackathon (Groww "Code" challenge). Deadline Monday 11:00 AM IST.

The brief: build a smart market watchlist that helps users track stocks, understand what has "meaningfully changed" since they last checked, and what deserves their attention now. Frontend and backend both ours. No prescribed UI, feature set, or architecture. Closing instruction from the organisers: *don't build the obvious watchlist — build the version you believe should exist, and be ready to explain why.*

## Our interpretation

Most submissions will read "meaningfully changed" as a property of the market: *this stock moved a lot.* We read it as a property of the **user's relationship with the stock**: *something changed that matters relative to why this particular person cares about this particular stock.*

So the product is not a price tracker. It's a **thesis-monitoring system**.

When a user adds a stock, we optionally capture *why*. From then on we don't just monitor the stock — we monitor the reason it's on the list. The user comes back to:

```
While you were away
  🔴 1 thesis contradicted
  🟢 2 conditions triggered
  ⚡ 1 event happened and reversed
  ○ 4 unchanged
```

Three distinct kinds of news, none of which a conventional watchlist can express:

- **Condition met** — the thing you were waiting for happened.
- **Thesis contradicted** — the reasoning behind why you were watching no longer holds.
- **Missed event** — something crossed your threshold while you were away *and reversed before you got back*. A current-state app can never show you this.

The statistical anomaly engine is not the product. It's the **infrastructure** that lets the thesis layer decide when something deserves attention.

## Hard product boundary

We are building attention infrastructure, not an advisory product.

- ❌ Never: "You should sell INFY." / "This is a good entry point." / any buy, sell, hold, or target.
- ✅ Always: "The condition you asked us to monitor has changed. Here is the evidence."

This is both an ethical line and a regulatory one in India. Every string in the UI is phrased as an observation about the user's own stated condition, never as a recommendation. Include a plain disclaimer in the footer and README.

---

## How this is judged

Five dimensions. Three are about judgement rather than features:

- **Engineering depth** — architecture, correctness, reliability, scalability
- **Product & problem interpretation** — understanding beyond the obvious brief ← *our main bet*
- **Edge cases & resilience** — failures, race conditions, integrity, unreliable dependencies
- **Code quality & simplicity** — maintainability **without unnecessary over-engineering**
- **Originality & thoughtfulness** — independent choices, considered approach

Read the fourth one carefully. No microservices, no Kubernetes, no Kafka, no GraphQL, no message queue. Depth goes into the thesis engine and the change engine. Everything else stays boring and obvious. Cutting a feature to keep the architecture clean is the *correct* trade here, not a compromise.

---

## Stack

- Next.js (App Router) + TypeScript, single deployable
- Postgres (Neon free tier)
- Drizzle ORM
- Tailwind
- `yahoo-finance2` for market data
- Deploy to Vercel; ingestion triggered by external cron hitting a protected route

If you want to swap something, say so before starting rather than substituting silently.

---

## PHASE 0 — Data validation (FIRST; report back before any app code)

Everything below depends on what the data source actually provides. Write `scripts/validate-source.ts` and check:

1. `RELIANCE.NS` daily OHLCV, 90 days. Gaps? Volumes present?
2. `^NSEI` (NIFTY 50), same window. Aligns on trading days?
3. A symbol with a known recent split — is the adjusted series correct? (This library is known to sometimes return wrong split/dividend adjustments. Verify, don't trust.)
4. Do NSE sector indices resolve? If not, we drop sector-relative signals and use NIFTY-relative only.
5. Fire ~60 sequential requests with no delay. Where does throttling start? What does the error look like?
6. What timestamp/staleness metadata comes with a live quote?

**Report results and wait for confirmation.** If it fails, fall back to NSE bhavcopy end-of-day CSVs.

---

## Build order

Ship a working vertical slice before anything clever. A plain watchlist deployed Friday night beats a brilliant engine that doesn't run.

1. **Slice** — auth, add/remove symbol, list with latest price. **Deploy it.** Verify on the deployed URL, not just locally.
2. **Ingestion + storage** — daily bars, quote polling, append-only snapshots, `symbol_stats`.
3. **Change engine** — anomaly detection (the infrastructure layer).
4. **Thesis engine** — capture, trigger evaluation, contradiction evaluation, lifecycle. ← *the differentiator*
5. **Digest UI** — "While you were away", the three event kinds, evidence panels.
6. **Missed-event replay** — the transient timeline.
7. **Edge cases + resilience** — corporate actions, stale data, feed failure.
8. **README + DECISIONS.md**, submit with buffer.

**Target submission: hour 50, not hour 71.** Only the first 1,000 submissions get evaluated, and we want room to refine after.

If we fall behind: cut the replay UI (keep the data), cut sector-relative residuals (use NIFTY-relative), cut thesis types down to `price_range` + `momentum_up` + `none`. Do **not** cut corporate actions or the evidence panel.

---

## Layer 1 — The change engine (infrastructure)

Three sub-layers. Keeping them separate is most of the design.

**Detection (global, per symbol).** Runs once per symbol regardless of how many users watch it. Emits append-only change events. This is the fan-out property that makes it scale: cost is O(unique symbols), not O(users × symbols).

**Scoring (global).** Each event gets a magnitude in normalized, comparable units.

**Personalization (per user).** Filter by watchlist membership, thesis relevance, and watermark. Rank. Render.

### Signals

- **Price move**, volatility-normalized: `z = return / (realized_vol_daily × √window_days)`, 20-day realized vol
- **Volume anomaly**: log ratio vs 20-day median volume
- **Benchmark-relative residual**: `residual = r_stock − β × r_index`, rolling 60-day beta vs NIFTY. If the market moved and the stock followed, that is not a signal.
- **Level crossings**: 52-week high/low, 20-day range breaks
- **Trend state**: position vs 20-day moving average
- **Overnight gap**

`symbol_stats` (realized vol, median volume, beta, 52w levels, 20D MA) recomputed on schedule. That table is what turns a hardcoded threshold into an actual judgement.

### Noise suppression

- **Cooldown with escalation** — after emitting for `(symbol, signal_type)`, suppress re-emission unless magnitude extends past the last emitted level by ~1.5×. Moves escalate; they don't repeat.
- **Hysteresis on crossings** — a stock oscillating 100.01 / 99.99 / 100.02 around its 52-week high fires once. Require a fall back below a re-arm band (~99.5%) before the signal re-arms.
- **Supersession** — a 1-hour event is absorbed by the 1-day event containing it. Show the parent; keep the child queryable via `supersedes_id`.

### Transient events (powers "you would have missed this")

Every change event carries `occurred_at` and a nullable `resolved_at`. When a condition ceases to hold, we set `resolved_at` rather than deleting the event. An event where `resolved_at IS NOT NULL` **and** the whole span falls inside the user's away-window is a **missed event** — the single feature most impossible to replicate with a current-state app.

Do not garbage-collect resolved events during the hackathon.

---

## Layer 2 — The thesis engine (the differentiator)

### Capture

When adding a stock, offer one optional question. **Skippable in one click** — never block the add flow. Default is `none`.

```
Why are you watching TCS?
  ○ Waiting for a dip          → price_range
  ○ Watching for a breakout    → breakout
  ○ Long-term candidate        → none (+ note)
  ○ Tracking momentum          → momentum_up
  ○ Watching for unusual moves → volatility_watch
  ○ Just watching              → none
```

Selecting a type may ask for one parameter (a price level or range). Free-text note allowed **alongside** the structured type, displayed back to the user verbatim, never parsed or interpreted.

**This is the key engineering decision:** theses are structured and machine-verifiable. We never ask an LLM whether a thesis is valid. Data decides. Write this in the README.

### Thesis types — trigger and contradiction rules

Every type needs *both*. Contradiction requires **at least 2 of 3 independent conditions** so a single noisy signal can't fire it.

| Type | Params | Trigger | Contradiction (≥2 of 3) |
|---|---|---|---|
| `price_range` | `low`, `high` | Adjusted price enters `[low, high]` | (a) price moves away from range by >1.5× the gap at creation; (b) realized vol >2× its level at creation; (c) 20D benchmark-relative residual < −5% |
| `breakout` | `level` | Close above `level` **with** volume ≥1.5× median (volume confirmation) | (a) close below 20D MA; (b) failed breakout — touched level then closed >3% below it; (c) residual negative over 10D |
| `momentum_up` | — | *Maintenance thesis: no trigger.* Status stays "still valid" while conditions hold | (a) price below 20D MA; (b) 20D return negative; (c) benchmark-relative residual negative over 20D |
| `momentum_down` | — | Maintenance thesis | Mirror of `momentum_up` |
| `volatility_watch` | — | Any anomaly event with \|z\| ≥ 2.0 | *No contradiction — pure trigger thesis* |
| `volume_expansion` | — | Volume ≥2× median for 2 consecutive sessions | (a) volume back below median 3 sessions running; (b) price unchanged ±1% over the period |
| `none` | — | Falls back to generic anomaly digest | n/a |

Store the *specific conditions that fired* on the event so the evidence panel shows real reasoning, not a recomputation.

### Lifecycle state machine

```
        ┌──────────────┐
        │   WATCHING   │◄────── acknowledge ──────┐
        └──────┬───────┘                          │
               │                                  │
      ┌────────┼────────┐                         │
      ▼        ▼        ▼                         │
 TRIGGERED  CONTRADICTED  STILL_VALID ────────────┘
```

Rules:

- **Minimum observation window**: a thesis cannot be contradicted within 24h of creation or of its last acknowledgement. You cannot contradict a thesis that is 20 minutes old.
- **Creation floor**: a thesis is only ever evaluated against data from `thesis_created_at` onward. If a user writes "interested below ₹2,800" today and the stock was there last week, **we do not fire.** Same discipline as the watermark.
- **Cooldown**: after firing, suppress the same `(thesis, event_type)` for 24h unless the evidence materially worsens.
- **Acknowledgement resets state**. User actions: *Review thesis* (edit params/type), *Keep watching* (acknowledge, reset window), *Stop watching* (remove).
- A `TRIGGERED` thesis can subsequently be contradicted. A `CONTRADICTED` thesis stays contradicted until acknowledged.

### Digest composition

Per user, per visit, in priority order:

1. Contradicted theses
2. Triggered conditions
3. Missed events (transient, resolved, inside the away-window)
4. Anomaly events for `none`-thesis symbols, ranked by magnitude
5. Everything else collapsed under "unchanged"

---

## Watermarks, race safety, and staleness

Per `(user, symbol)` — not one global timestamp. Opening one detail page must not clear everything.

- **Monotonic and idempotent**: always `last_seen_at = GREATEST(last_seen_at, $new)`, never a blind overwrite. Two open tabs is a real race.
- **Cutoff sequencing**: generate the digest against a captured cutoff, and only advance the watermark *after* the response succeeds. Critically, **the cutoff must be the completion timestamp of the last fully-committed ingestion batch, never `now()`** — otherwise an event whose `detected_at` precedes the cutoff but which commits after the digest query runs is skipped forever. Track batch completion explicitly in `ingestion_batches`.
- **UX race**: if opening the digest marks everything read, a refresh empties it and the user loses their place. Freeze a digest snapshot for the session; commit the watermark on dismiss or navigate-away. Separate "seen" from "acknowledged".
- **New symbol**: set watermark to *now*. Don't replay three months of history at someone.
- **Market closed**: if the away-window spans a weekend or holiday, say "market closed since your last visit", not "no changes". Different statements.

---

## Corporate actions

The trap most submissions will fall into. A 1:5 split makes a naive price diff report an 80% crash.

Store raw **and** adjusted prices; compute all diffs on the adjusted series.

Two subtle parts, both of which are strong Q&A material:

1. **The user's stored watermark price must be adjusted forward** on a split, or their personal baseline is silently wrong.
2. **Thesis parameters must be adjusted too.** A user watching for "below ₹2,800" pre-split is watching for below ₹560 post-split. If you don't adjust the thesis, it fires immediately and wrongly. Show the user that the adjustment happened — don't silently rewrite what they typed.

Handle splits properly. If dividends are too much, list them as a known deferred limitation in the README rather than half-doing it.

---

## Unreliable data

Every feed behind a provider interface with two adapters: `live` and `replay` (deterministic, from a committed fixture). Not a shortcut — it makes the 18 Sep demo reproducible when a free API rate-limits us, and it's a defensible design choice.

Circuit breaker on the live adapter. Serve last-known-good with a visible as-of timestamp. **Never render stale data as though it were live.** Every quote carries freshness metadata and the UI shows it.

### Deployment constraint — do not skip

Yahoo throttles datacenter IPs harder than residential ones, and free-tier host IP pools are heavily hammered. The app can work perfectly locally and 429 minutes after deploy.

**The deployed app must never do a cold historical backfill.** Fetch history locally, commit as a seed file, load into the DB at deploy. The deployed service polls only current quotes for a capped universe (50–100 symbols) on a fixed schedule with jitter and backoff. Cache aggressively.

### Demo fixture

Build the replay fixture so it **deterministically produces one of each event type**: a contradiction, a trigger, and a missed event that fires and reverses. The missed-event replay is our best demo moment and it must not depend on the market happening to cooperate on 18 September.

---

## Schema

```
symbols
price_bars            (raw + adjusted)
corporate_actions
symbol_stats          (realized_vol, median_volume, beta, 52w_high, 52w_low, ma20)

change_events         (symbol, type, window, magnitude, score, detected_at,
                       occurred_at, resolved_at, ingestion_batch_id,
                       supersedes_id, explain_json)

watchlists
watchlist_items       (user_id, symbol, created_at)

theses                (watchlist_item_id, type, params_json, note,
                       created_at, state, last_acknowledged_at,
                       params_adjusted_at)

thesis_events         (thesis_id, kind: triggered|contradicted|missed,
                       occurred_at, resolved_at, conditions_met_json,
                       evidence_json, acknowledged_at)

user_symbol_read_state (user_id, symbol, last_seen_at,
                        last_seen_price_adj, last_seen_event_id)

ingestion_batches     (id, started_at, completed_at, status)
```

`explain_json` and `evidence_json` store the **actual inputs at detection time** (z-score, vol used, beta, index return, which conditions fired). Do not recompute for display — stats drift and the numbers won't match, which is exactly the inconsistency a reviewer will catch.

Postgres is sufficient. We do not need a time-series database at this scale, and choosing not to add one is a defensible answer.

---

## UI scope — four surfaces, nothing more

- **Auth** (minimal)
- **Digest / home** — "While you were away", counts by kind, then the cards. Does **not** lead with prices.
- **Symbol detail** — thesis vs reality: what you said, what happened, what changed around it, current status. Plus the missed-event replay timeline.
- **Add flow** — symbol search + the optional thesis question

No landing page, no onboarding, no dark mode toggle, no profile settings, **no sensitivity slider** (the thesis replaces it — user-defined conditions are better personalization than a global knob).

### Evidence display rule

Never show an invented composite like "Attention score: 82/100 — price anomaly 31/35". Where does 35 come from? A reviewer will ask and the honest answer is "I made it up." Show real units:

```
TCS  −4.6%
Move = 2.3σ vs 20-day realized volatility
Volume = 1.9× 20-day median
NIFTY = −1.2%
Stock-specific residual = −3.1%

Your condition: "Interested below ₹2,800"
Entered your range 47 minutes ago.
```

Rank internally by a composite if needed, but expose evidence, not arithmetic.

---

## AI positioning

The core product is deterministic and fully functional with no AI. If we add LLM summaries at all, they are optional presentation garnish, never a system dependency. If the AI call fails, the product works identically.

**The AI never decides whether a thesis is valid. Data does.**

---

## Documentation — start day one, not Sunday night

**`DECISIONS.md`** — maintained AS WE GO. Every trade-off, what we rejected, why. Two of five rubric dimensions and the entire 5-minute Q&A are about reasoning. Reconstructing it Sunday night is much harder than logging it live. Append after each significant decision without being asked.

**`README.md`** — setup instructions (required for submission), architecture overview, explicit **known limitations**. Include verbatim:

> The core product is deterministic and fully functional without AI. The AI layer is optional presentation garnish, not a system dependency.

> Theses are structured and machine-verifiable rather than free-text. We never ask a language model whether a user's reasoning still holds — every trigger and contradiction is evaluated deterministically against market data.

> We intentionally excluded news-based cause attribution because unreliable entity matching and timestamp alignment could create false explanations. We preferred defensible quantitative evidence over speculative causality.

> Thesis is an attention tool, not an advisory product. It reports changes to conditions the user defined. It does not make recommendations.

---

## How to work

- Start with Phase 0 and stop for confirmation.
- Push back if I ask for something that adds complexity without earning it. Simplicity is a scored dimension.
- Small commits with clear messages — the history is part of what gets reviewed.
- If about to build something not in this spec, ask first.

Start with Phase 0.