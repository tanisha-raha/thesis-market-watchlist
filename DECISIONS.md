# Decisions

Maintained as we go. Newest last.

---

## 2026-09-04 — Phase 0: stay on yahoo-finance2, no bhavcopy fallback

**Decision.** Keep `yahoo-finance2` as the market data source. Do not fall back to NSE bhavcopy CSVs.

**Why.** All six Phase 0 checks passed. Daily OHLCV is complete and gap-free, `^NSEI` aligns
exactly on trading days, split adjustments verified correct against three real recent splits,
sector indices resolve with 500+ bars of history, live quotes carry a genuine exchange timestamp,
and I could not provoke throttling at all. Full evidence in `reports/phase0.md`.

**Rejected.** NSE bhavcopy end-of-day CSVs — end-of-day only, so it cannot support intraday
transient events, which is the missed-event feature and our best demo moment.

---

## 2026-09-04 — `price_bars` stores as-observed prices, not "raw" prices

**Decision.** `price_bars` holds a `close_as_observed` written once at ingestion and never updated,
alongside a `close_adj` refreshed from the provider. Diffs compute on the adjusted series.

**Why.** Phase 0 established that Yahoo returns **no raw price series**. Requesting 2024-11-05 from
a window starting after RELIANCE's 2024-10-28 split and from a window spanning it returns the
identical `close` — split adjustment is baked in and applied retroactively to all history.
`adjclose` differs only by dividends. So the brief's "store raw and adjusted" cannot be implemented
literally; the only raw record available is what we ourselves observed on the day.

**Bonus property.** This is not merely a workaround. When the provider's history for a bar we
already stored changes, the ratio between as-observed and newly-adjusted *is* the split factor —
so the schema that survives the constraint also gives us corporate-action detection for free.

---

## 2026-09-04 — Poll with batched quotes, and reconcile the response by symbol

**Decision.** Quote polling uses `quote(string[])` in batches of ~50. Every response is reconciled
against the requested symbol list; a symbol that does not come back is recorded as a stale-data
event, not skipped.

**Why (batching).** 50 symbols resolve in one HTTP request in 3.8s. For a 50–100 symbol universe
that is 1–2 requests per poll instead of 50–100 — the cheapest available mitigation for the
datacenter-IP throttling risk the brief flags, which our residential-IP testing provably cannot
measure.

**Why (reconciliation).** Batched quote **silently drops** symbols it cannot resolve: 50 requested,
49 returned, no error and no null. We hit this for real — `TATAMOTORS.NS` no longer resolves,
consistent with the Tata Motors demerger. Without reconciliation a delisted or renamed symbol goes
quiet forever and the user is never told their watchlist item stopped being monitored, which is a
silent failure of exactly the promise the product makes.

---

## 2026-09-04 — Throttle test is inconclusive; resilience plan does not relax

**Decision.** Treat Phase 0's clean throttling result as a negative result. Circuit breaker,
`live`/`replay` provider adapters, and the never-cold-backfill-on-deploy rule all remain mandatory.

**Why.** 250 sequential quotes at 10.3 req/s produced zero failures, so we have no observed error
shape to design against. But the test ran from a residential IP and the brief's specific warning is
that Yahoo throttles datacenter IPs harder. An untested failure mode is not an absent one, and
"it worked on my machine" is the exact shape of the failure the brief predicts.

---

## 2026-09-04 — Always request long windows and slice locally

**Decision.** All historical fetches request a long window (2y) and slice to the window we need
in application code.

**Why.** A 30-day request for `^CNXAUTO`, `^CNXFMCG`, `^CNXMETAL` and others returned **1 bar**;
the same symbols returned 501 bars for a 730-day request. Short windows fail silently with a
plausible-looking response. Had Phase 0 only run the 30-day check we would have shipped garbage
betas with no error anywhere.

---

## 2026-09-04 — Sector-relative signals stay a stretch goal; `^CNXFIN` unusable

**Decision.** NIFTY-relative residuals are the primary benchmark signal, as the brief specifies.
Sector-relative is a stretch goal, and financials fall back to NIFTY if we build it.

**Why.** Eleven NSE sector indices have 2 years of usable history, so the signal is buildable. But
`^CNXFIN` returns 1 bar and `NIFTY_FIN_SERVICE.NS` likewise — there is no working sector index for
financials, a large slice of any Indian watchlist. A signal that silently does not apply to
banking names is worse than one benchmark applied consistently.

---

## 2026-09-04 — Supplement Yahoo name search with a small NSE directory

**Decision.** Keep Yahoo as the market-data authority and add a small, curated NSE name-to-ticker
fallback for common companies in search. Adding a result still validates it with Yahoo's quote
endpoint before it can enter a watchlist.

**Why.** Yahoo search is incomplete for NSE company-name queries: `infosys` returned overseas
listings but omitted `INFY.NS`, while a ticker query for `INFY` or `INFY.NS` resolved it correctly.
The fallback makes the name-search promise reliable without treating an unverified local mapping as
market data or broadening the provider architecture.

---

## 2026-09-04 — Smoke tests load local configuration explicitly

**Decision.** `npm run smoke` loads `.env.local` if it exists and runs with Node's `react-server`
export condition, matching Next.js's resolution of `server-only` modules.

**Why.** Next.js loads `.env.local` automatically, but standalone `tsx` does not. Without this,
the documented smoke command fails with `DATABASE_URL is not set` even when local development is
correctly configured. A plain Node runner also resolves `server-only` to its intentional throwing
client stub; the React server condition resolves its empty server marker instead. Production still
supplies environment variables through its host; no local secret is committed or required by the
script.

---

## 2026-09-04 — Production browser checks wait for the persisted watchlist row

**Decision.** The production E2E waits for the row-specific `Remove RELIANCE.NS` control after
adding a symbol, rather than any visible `RELIANCE.NS` text. It also verifies that an unresolvable
symbol is explicitly rejected.

**Why.** The add field's autocomplete may render a `RELIANCE.NS` suggestion before the Server
Action has completed its quote refresh and revalidation. The old selector treated that suggestion
as a persisted row, then inspected the page too early; this was reproducible under Vercel's slower
request timing and produced false missing-price/change/freshness failures. Waiting for the Remove
control synchronizes on the actual persisted row without an arbitrary delay. The unresolvable
case exercises the required reconciliation of Yahoo's silent symbol drops.

**Production observation.** On `thesis-market-watchlist.vercel.app`, the corrected E2E passed:
Yahoo supplied RELIANCE.NS price, previous-close movement, and exchange freshness; `infosys`
returned INFY.NS; and `NOTAREALTICKER.NS` was refused. Vercel request logs for this run showed only
successful application requests and no 429, timeout, or thrown-error record. They do not expose
upstream Yahoo request durations or payloads, so individual provider latency was not measurable
from the available logs. The successful flow completed within the E2E's 40-second persisted-row
timeout; no claim beyond that bound is made.

---

## 2026-09-04 — Phase 2 preserves first-observed Yahoo history explicitly

`price_bars` stores immutable first-observed provider values separately from the refreshable current
provider projection. These are not vendor "raw" prices: Phase 0 proved Yahoo restates its history.
Every batch is first persisted as STARTED; only successful database commits mark it COMPLETED.
Per-symbol omissions are reconciled feed outcomes, not batch failures.

---

## 2026-09-04 — The cut list, decided in advance

**Decision.** Written at Fri 16:45 IST, while rested, so that it is already made when
we are tired and attached to everything. Cut in this order, without renegotiating:

1. **Sector-relative residuals.** Already a stretch goal — NIFTY-relative is the
   primary benchmark and `^CNXFIN` has no usable history anyway.
2. **Supersession logic** (`supersedes_id`, parent/child event absorption). The
   cooldown and hysteresis rules already suppress most repeat noise; supersession
   is the refinement on top, not the mechanism.
3. **Thesis types down to `price_range`, `momentum_up`, `none`.** These three cover
   a trigger thesis, a maintenance thesis, and the generic-anomaly fallback — the
   full shape of the engine is still demonstrable. `breakout`, `momentum_down`,
   `volatility_watch` and `volume_expansion` are more instances of a pattern that
   is already proven by the first three.
4. **Missed-event replay UI** (the timeline view). This cut was later avoided:
   the digest now renders the persisted intraday interval, duration, and the
   daily-close blind spot from the same event data. There is no separate fake
   replay path.

**Never cut, at any hour:**

- **Corporate-action thesis adjustment.** Detection without adjustment is worse
  than neither: we would know the user's ₹2,800 became ₹560 and let it fire wrongly
  anyway.
- **The evidence panel.** It is the difference between a judgement product and a
  number generator, and it is where two of five rubric dimensions are won.
- **The five tests.**
- **README.md.** A submission requirement.

**Why write this now.** Capacity is realistically 30–34h across two nights, not the
37h the plan assumes, and the estimates are the optimistic case. A cut list decided
under time pressure gets negotiated against sunk cost; one decided in advance gets
executed. Cutting a feature to keep the architecture clean is the correct trade, not
a compromise.

**Hard constraint.** Phase 4 (the thesis engine) starts by **Saturday 14:00 IST**,
without exception. If Phase 3 is unfinished at that hour, we cut into Phase 3 using
the list above rather than delaying Phase 4. A shipped thesis engine on a thinner
change engine beats a perfect change engine with no thesis engine: interpretation
and originality are what we are differentiating on, and they live in Phase 4.

---

## 2026-09-04 — Intraday history: seed 5m bars now, poll continuously, keep both in one series

**Decision.** Three things, in priority order. Seed 5-minute bars for the universe
from a locally-fetched, committed file. Start continuous quote polling immediately.
Keep the deterministic replay fixture mandatory regardless of both.

Both intraday sources land in `quote_observations` with a `source` column
(`poll` | `bar_5m`), rather than in a separate table.

**Why seed 5m bars.** Polling alone accumulates only from the moment it starts: at
submission on Monday a judge opening the app would find an empty replay. Yahoo
serves 5m bars for ~60 days, so seeding gives the missed-event feature a populated
history on day one. The window also slides — history not captured today is gone
permanently — which is why this ran first, before any bug fixes.

**Why fetch locally and commit.** The deployed app must never cold-backfill. Yahoo
throttles datacenter IPs harder than residential ones, and free-tier host IP pools
are heavily used. `ingestHistory` already refuses to run when `process.env.VERCEL`
is set.

**Why one series rather than a separate intraday table.** The missed-event detector
then has exactly one code path over one time-ordered series, whichever source a
point came from. Code paths are what cost us hours at this stage. The honest
trade-off is that a 5m bar close is an aggregate while a poll is a point sample; the
`source` column records which, so nothing is silently conflated.

**Why the loader stores only the close, while the seed file keeps full OHLCV.** A
threshold crossing that reverses inside a single 5-minute bar is below our detection
resolution, and claiming otherwise would overstate what we can see. But the fetch is
irreversible and the load is not, so the committed file retains open/high/low/volume
in case we later want intra-bar crossings. Capture everything once; decide what to
use as often as we like.

---

## 2026-09-04 — Never edit an applied migration

**Decision.** Migrations are append-only. A mistake in an applied migration is
corrected by a new one, written to be idempotent. `0001` is left exactly as it is.

**Why.** `corporate_actions` was added to `0001_phase2_ingestion.sql` *after* that
migration had already run. Drizzle records migrations by hash and never re-runs one
it has seen, so `npm run db:migrate` reported "migrations applied" and did nothing.
The result was a database that had four of the five Phase 2 tables, a journal that
claimed all five, and no error anywhere. A fresh database would have been correct;
an already-migrated one silently was not — and production could have been on either
side of that split.

`0002_phase2b_levels_source.sql` is therefore idempotent by construction:
`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and foreign keys guarded on
`(table, column)` rather than on constraint name, because `0001` created the same
relationships under different names and matching on name alone would have added a
second, duplicate foreign key. Verified against both states: an already-migrated
database and a freshly created one both converge on the same 10 tables and 13
foreign keys.

**Also fixed.** `0001` was hand-written with no snapshot in `meta/`, so the next
`drizzle-kit generate` would have diffed against `0000` and emitted a migration
re-creating every Phase 2 table. `0002` was generated by drizzle (then edited for
idempotency), which restored a correct `0002_snapshot.json`.

---

## 2026-09-04 — Any helper that writes inside a transaction takes the transaction

**Decision.** `recordPollOutcome` takes an explicit `DbExecutor` — either the pooled
client or an open transaction handle — and uses it. The type is exported from
`db/index.ts` so the rule generalises.

**Why.** `ingestQuotes` opened a transaction and called `recordPollOutcome` from
inside it, but that function closed over the module-level `db`. Drizzle binds `tx`
to a reserved connection, so those writes went out on a *different* connection:
outside the transaction, and surviving its rollback. The transaction looked correct
and was not, which is more dangerous than having no transaction at all.

Confirmed empirically before fixing: forcing a rollback left `ingestion_batches`
correctly empty while `consecutive_feed_misses` advanced 0 → 1 and stayed. The
practical consequence is that a failed batch could push a symbol toward a false
"we have stopped monitoring this" — a false alarm on the exact promise the product
makes.

**Note on the original concern.** The worry was that network I/O sat inside the
transaction. It did not: both `provider.getQuotes` and `provider.getDailyBars` were
already awaited before `db.transaction` opened. That part was already right.

---

## 2026-09-04 — Scheduled ingestion is the only writer of quotes

**Decision.** `/api/ingest`, protected by `CRON_SECRET` and triggered by an external
cron, is the only path that fetches quotes. Page loads render what it committed.
`addSymbol` persists the quote it already fetched to validate the symbol, so a
newly added row shows a price immediately rather than waiting for the next poll.

**Why.** Page loads previously fetched quotes inline, which makes upstream request
volume a function of user traffic rather than of a fixed schedule — the pattern most
likely to trip the datacenter-IP throttling the brief warns about, and which our
residential-IP testing provably could not measure. It also put an unpredictable
remote call on the critical path of every render.

This is also what "serve last-known-good with a visible as-of timestamp" means in
practice: every row carries the exchange timestamp of the price shown and the UI
states its age. The route refuses every request when `CRON_SECRET` is unset rather
than failing open, because an unprotected ingestion route is an open proxy to our
provider and the fastest way to get rate-limited.

---

## 2026-09-04 — Five integration tests, and what they are for

**Decision.** Five tests, each protecting a promise rather than a line of code:
last-known-good survives a failed or incomplete poll; first-observed history is
immutable under provider restatement; historical ingestion is idempotent; stats
never emit NaN or Infinity; a rollback removes every partial write.

**Why five.** The thesis engine — the actual differentiator — has no code yet. A
large database-backed suite over ingestion would be effort spent on the part of the
system we are least worried about. Everything else is verified manually and recorded
here.

**The rollback test was written to fail.** Reverting `recordPollOutcome` to its
previous form reproduces `misses 0 -> 1` and the test fails; with the fix in place it
passes. A test that would have passed against the bug it claims to cover is not
evidence of anything.

**To add later, not now:** watermark monotonicity and digest-cutoff sequencing. It
protects the subtlest rule in the brief, but the code does not exist until Phase 4/5.

---

## 2026-09-04 — Statistics are computed on adjusted closes, over traded sessions only

**Decision.** Every level and every return in `symbol_stats` uses the adjusted close
and only sessions where the market actually traded. 52-week and 20-day high/low are
added, both from adjusted closes rather than intraday highs and lows.

**Why traded sessions only.** Yahoo emits phantom bars on NSE holidays: equities get
a real carried-forward close with `volume: 0`, indices get a null close. Including
them injects a spurious 0% return that deflates realized volatility — the denominator
every other signal is normalized by. Observable in the result: `sessions_used` is 496
against 501 stored bars, the difference being exactly the five holiday dates Phase 0
identified.

**Why 52-week levels at all.** The brief specifies `52w_high`/`52w_low` in
`symbol_stats`, the change engine's level-crossing signal is explicitly 52-week *and*
20-day, and hysteresis re-arming needs a stored level to compare against. Neither was
present. The cost is two reductions over bars already fetched.

**Why closes rather than intraday highs.** We have no adjusted high or low from the
provider. Mixing an unadjusted intraday high with an adjusted close would be
incoherent across a split — the precise failure the corporate-actions work exists to
prevent. A close-based 52-week high is slightly conservative and always consistent.

---

## 2026-09-04 — Transience is implemented once, as a latched condition

**Decision.** Every transient signal — level crossings, volatility-normalized price
moves, trend state, volume anomalies, benchmark residuals — is expressed as a
condition sampled over time and run through a single `latch` function.
`occurredAt` is when the condition became true; `resolvedAt` is when it stopped.

**Why one implementation.** `resolvedAt` looks like a field and is actually the
whole missed-event feature. Implemented per signal it would be correct for the
signal we tested and quietly wrong for the others, and the failure is invisible —
a missing missed-event looks exactly like a market that did not do anything.
Sharing one latch means transience is either right everywhere or wrong everywhere,
and a test on one signal is evidence about all of them.

**`resolvedAt` is when the condition ceased to hold, not when it re-armed.** Those
are deliberately different instants. Resolution answers "when did this reverse",
which the user is owed honestly. Re-arming is a separate, stricter test that gates
whether a NEW event may open, and exists only to stop an oscillation from emitting
a burst.

---

## 2026-09-04 — Resolution is evaluated against the intraday series, and here is the proof

**Decision.** Transient resolution reads `quote_observations` — live polls and
seeded 5-minute closes as one ordered series — never daily bars.

**The proof, from real seeded data.** GRASIM.NS on 2026-08-10:

| | |
|---|---|
| 52-week high (adjusted closes) | ₹3380.50 |
| 11:50 IST | ₹3376.70 — below |
| 11:55 IST | ₹3385.20 — **crossed**, event opens |
| intraday peak | ₹3407.70 |
| 14:15 IST | ₹3371.00 — **fell back**, `resolvedAt` set. 140 minutes open |
| **daily close** | **₹3380.50 — exactly the level, not above it** |

On daily bars this event does not exist. The close is not above the 52-week high,
so a daily-bar implementation reports nothing at all — not a smaller event, no
event. That is the failure mode this decision exists to prevent, and it is why the
5-minute seed was fetched before anything else in Phase 2.

The same trace also demonstrates hysteresis working: the price re-crossed the level
at 14:30 but never fell through the re-arm band at ₹3363.60, so no second event was
emitted. The brief's 100.01 / 99.99 / 100.02 case, on real data.

Resolved events are never deleted and `resolvedAt` transitions null → value exactly
once. That is enforced in SQL, not in application code: the upsert sets
`resolved_at = coalesce(change_events.resolved_at, excluded.resolved_at)` under a
`WHERE resolved_at IS NULL` guard, so no later run can move or clear it. Tested in
both directions.

---

## 2026-09-04 — Detection is limited to a 60-day window

**Decision.** `runDetection` only considers events in the last 60 days, matching the
intraday history we hold.

**Why.** `symbol_stats` describes a symbol as it is NOW — today's realized
volatility, today's 52-week levels. Applying today's statistics to bars from two
years ago produces confident nonsense: a November 2024 session scored against 2026
volatility read as an 8-sigma overnight gap. Running unbounded, detection emitted
13,221 events; bounded to the window our statistics can honestly describe, and with
the gap bug below fixed, it emits 1,658 — about 33 per symbol over 60 days. We only
claim events for the period we can actually justify.

---

## 2026-09-04 — Two bugs in the overnight gap, both from mixing series

**What happened.** The overnight gap fired on roughly a third of all sessions, at an
average of 4 sigma. Two independent causes, both the same mistake in different
clothes.

1. **`price_bars` had no open column.** The gap was computed as `close / prevClose`,
   which is not a gap — it is the daily return with a misleading name. Fixed by
   storing `current_provider_open`; the seed file already had it, because the 5m and
   daily fetches deliberately captured full OHLCV on the grounds that the fetch is
   irreversible and the load is not. That decision paid for itself within a day.

2. **The open is unadjusted, the previous close was adjusted.** The provider gives
   us no adjusted open, so comparing a raw open against a dividend-adjusted previous
   close injected the entire adjustment ratio into every gap. For RELIANCE that ratio
   ran to 0.99144 — against a daily volatility of ~0.9%, a full sigma of pure
   artefact. The gap now compares raw against raw, and `explainJson` records that it
   does.

This is the same class of error as computing a 52-week high across a split, and it
is worth stating plainly: *any ratio between two prices must take both from the same
series.* Both bugs were caught by looking at the output distribution rather than by
a test, which is an argument for always inspecting what a new detector actually
emits before trusting it.

---

## 2026-09-04 — Magnitude, score, and evidence are three different things

**Decision.** Each event carries `magnitude` in the signal's own natural unit (a
z-score, a fraction above a level, a log volume ratio), a `score` normalized for
ranking, and `explainJson` holding the actual inputs at the moment of firing.

Only `explainJson` is ever rendered. `score` exists solely to order a digest and is
never shown, nor is anything derived from it — no composite, no "attention score out
of 100". A reviewer asking where a number came from must always get a real answer.

`explainJson` is written once and never updated. It is the evidence for a claim made
at a particular moment; recomputing it later against drifted statistics would
produce evidence for a claim we are no longer making, and the mismatch is exactly
what a careful reader would catch.

---

## 2026-09-04 — The thesis rules were calibrated against seeded history, not just tested

> **The short answer, for "how did you avoid false alarms?"**
>
> We didn't trust the tests. Every contradiction rule passed its unit tests on the
> first run, so we instantiated all six thesis types on all fifty symbols across
> sixty days of real history and measured how often each actually fired. They
> contradicted 92–100% of symbols — a system that tells you your reasoning failed on
> every stock you own is telling you nothing. Three defects, none test-visible: the
> cooldown never fired because daily sessions sit exactly 24h apart, on the boundary;
> the "two of three independent conditions" weren't independent, because 20-day
> return and price-vs-20-day-average are nearly the same measurement, so two-of-three
> collapsed to one-of-two; and there was no persistence requirement, so a single day
> below a moving average counted. We fixed the first structurally rather than with a
> bigger constant — a contradiction is a state, not a recurring event — added a
> volatility-scaled noise floor chosen by sweeping it, and required three consecutive
> sessions. Rates now run 18–56%. `npm run calibrate` reproduces the table.

**Why this section exists.** Every rule below passed its unit tests from the first
run. The tests were not the problem. Run across 60 days of real history the same
rules contradicted 92–100% of symbols, which means a user would be told their
reasoning had failed on almost every stock they watched — indistinguishable from
telling them nothing. Correctness and calibration are different properties and only
one of them is visible to a test suite.

**Measured before any tuning**, all six types, 50 symbols, 60 days:

| type | triggered | contradicted | contradictions/symbol |
|---|---|---|---|
| price_range | 80% | 22% | 1.76 |
| breakout | 50% | 96% | 17.60 |
| momentum_up | — | 96% | 20.18 |
| momentum_down | — | 100% | 22.82 |
| volatility_watch | 100% | — | — |
| volume_expansion | 62% | 100% | 6.66 |

Three separate defects, none of which a test would have caught.

**1. The cooldown never fired.** Daily sessions are timestamped at the NSE close, so
consecutive sessions sit *exactly* 24 hours apart — precisely on the cooldown
boundary, which the comparison treated as expired. Seventeen to twenty-two
near-identical contradictions per symbol.

The fix is not a bigger constant. A contradiction is a **state, not a recurring
event**: the brief says a contradicted thesis stays contradicted until acknowledged,
so the engine now emits at most one and stops. Acknowledgement resets the evaluation.

**2. The conditions were not independent.** The brief asks for two of three
*independent* conditions. Taken literally, "20-day return negative" and "price below
the 20-day moving average" are very nearly the same measurement, so two-of-three
quietly collapsed to one-of-two. A return negative by 0.1% is not evidence that
someone's reasoning failed; it is rounding.

Each directional condition now has to clear a noise floor expressed in the symbol's
own 20-day move (σ₂₀ = daily realized volatility × √20), so it means the same thing
for a utility as for a small-cap. The floor was chosen by sweeping it, not picked:

| floor | breakout | momentum_up | momentum_down |
|---|---|---|---|
| 0σ | 90% | 92% | 79% |
| 0.25σ | 84% | 92% | 64% |
| 0.5σ | 66% | 72% | 57% |
| 0.75σ | 52% | 64% | 50% |
| **1.0σ** | **34%** | **42%** | **43%** |

**3. Contradiction had no persistence requirement.** Any stock spends *some* day
below its moving average. The conditions must now hold for three consecutive
sessions, and the verdict is dated to the session the run began — that is when the
thesis actually stopped holding; the following sessions are what make us confident
it was not a wobble. The brief's principle is that one noisy signal must never fire a
contradiction; requiring independent conditions applies that across signals, and
requiring persistence applies the same idea across time.

**Also corrected: the calibration itself was unfair.** Momentum theses were being
instantiated on all 50 symbols including ones already falling. No user writes
"tracking momentum" on a stock in a downtrend, so the rule was being measured against
a prior nobody has. Momentum theses are now only instantiated where the premise held
at creation (36 symbols up, 14 down). This changed the numbers barely at all — 94% to
92% — which is itself the useful result: it ruled out the easy explanation and forced
the real diagnosis.

**After all three fixes:**

| type | triggered | contradicted | contradictions/symbol |
|---|---|---|---|
| price_range | 80% | 18% | 0.18 |
| breakout | 50% | 34% | 0.34 |
| momentum_up | maintenance | 42% | 0.42 |
| momentum_down | maintenance | 43% | 0.43 |
| volatility_watch | 100% | n/a | — |
| volume_expansion | 62% | 56% | 0.56 |

`volatility_watch` triggering on every symbol is intended: the user asked to be told
about unusual moves, and a 2σ move occurring at least once in two months is the
expected case, not a defect. Momentum types have no trigger by design — they are
maintenance theses whose news is that they are still valid.

`npm run calibrate` reproduces the table; `FLOOR=n` sweeps the noise floor.

---

## 2026-09-05 — Reference-led authenticated workspace redesign

**Scope.** Rebuilt the presentation of Home, Watchlist, Digest and Symbol Detail
around the supplied terminal reference: persistent left navigation, top company
search, restrained mountain banner, dense cards/table, evidence and a visible
right-hand THESIS AI panel. The sidebar exposes only real routes. At widths below
1280px chat becomes a native modal drawer; below 768px navigation becomes a menu.
Add Stock uses the existing form/actions inside a native dialog. No UI framework
or dependency was added. Login/signup actions, schema, provider, ingestion,
detection, thesis evaluation and replay logic were not rewritten.

**Truthfulness and read boundaries.** Home reads the existing digest without
advancing its watermark. The full Digest retains its existing browser read receipt
and completed-batch cutoff. New `lib/presentation.ts` queries are read-only: saved
user-scoped theses, the already-stored ^NSEI quote, usable stored daily closes, and
latest evidence behind watchlist membership. Featured evidence does not disappear
merely because the digest has been read; it is separately timestamped so its price
cannot be confused with today's quote. User notes remain display-only, unchanged.

Charts show up to 60 stored adjusted daily closes and the actual NSE date range.
Null/nonpositive closes and zero-volume bars are excluded. These are not invented
intraday sparklines. Company marks are ticker initials, not fabricated logos.
SENSEX, NIFTY BANK, Top Movers, news, portfolios and fake reference-only features
were intentionally omitted. No new market-data subsystem or cold backfill was
introduced.

**Feed status.** The shell uses the oldest watched exchange timestamp, with missing
and degraded outcomes taking precedence. An exchange timestamp older than 36 hours
is conservatively STALE even if its old market state said CLOSED; recent closed
quotes say MARKET CLOSED, regular quotes say DELAYED, and absent quotes say
AWAITING DATA. None claims a verified LIVE stream. Explicit `THESIS_DATA_MODE=demo`
labels the shell, quotes and explanation panel DEMO REPLAY. Actual instants remain
rendered in IST; trading dates remain dates. Last-known-good values are untouched.

**Ask THESIS.** The existing scoped `/api/ask` and deterministic response system
remain the source. Sidebar activation opens/focuses the same conversation UI;
desktop presents a persistent panel and smaller screens a drawer. The only answer
selection change is recognizing the word “evidence” as the existing event-evidence
intent, with a regression assertion. No LLM, predictions or investment advice was
added. Transport failure is visibly isolated to chat.

**Visual QA details.** Screenshot review found and corrected stretched empty
panels, a below-fold Home composer, closed-menu focus, and a screen-reader table
label whose absolute positioning escaped its horizontal scroll container. The
table now contains its positioning context and exposes a mobile swipe hint; it
does not hide financial columns. Long timelines scroll within their panels.
Screenshots disable transitions and reset page scroll before capture, avoiding
mid-transition/focused-offscreen artifacts without arbitrary sleeps.

The responsive browser script covers 1536×864, 1440×900, 1000×800 and 390×844,
empty/new accounts, long company names and notes, a populated watchlist, all four
pages, chat focus/drawers, INFY evidence/thesis, advisory refusal and isolated chat
failure. The historical visual check is restricted to local hosts/databases and
copies existing demo-owned records into a disposable account; it never fabricates
market events or resets the source account's watermarks. Its own account is removed
after screenshots. Financial fixtures are never added to the production UI.

**Artwork.** `public/images/thesis-mountains.png` was generated with the built-in
image generation tool (not a CLI). Prompt direction: a photorealistic Himalayan
mountain panorama at a slate/navy dawn, mist, dark left-side negative space for
white copy, and no text, logos or finance symbols. This is decorative artwork only;
charts, prices and evidence still come from the application.

**Local verification.** TypeScript passes; `npm test` passes 80 assertions and
`npm run smoke` passes 31. The authenticated browser regression passes including
logout/login watchlist and note persistence. The default `npm run build`
encountered a local Turbopack worker `Operation not permitted` error; the same
application builds successfully with `npm run build -- --webpack`. No production
build configuration was changed to conceal this environment limitation.

The local responsive suite passed on all four pages at every target size, including
mobile table-action reachability and repeated desktop chat focus. The isolated
historical fixture showed 2 triggered, 1 contradicted and 4 missed events; all four
populated digest layouts passed, and the disposable account was removed. The
pre-existing demo account and all shared market data were preserved.

**Canonical production verification.** Deployed source commit
`97708b65ebb743638b666e43a4f114c39b78605a` to deployment
`dpl_8cQUkHJXUSGHckKhDmAw6aRdYqdm`
(`thesis-market-watchlist-ebqh0ybb3-tr-f64f.vercel.app`). Vercel's deployment API
confirmed that commit SHA; inspection confirmed the alias
`https://thesis-market-watchlist.vercel.app` points to it. The normal production
`npm run build` passed with Turbopack.

Against the canonical URL, `npm run browser-check` passed with zero failures:
signup/login, empty state, RELIANCE price/change/freshness, Infosys search and add,
structured INFY thesis and unchanged note, symbol detail, Home, Digest, visible
Ask THESIS, grounded answers and advice refusal, logout/login persistence,
unresolvable-symbol refusal, removal and post-logout gating. No uncaught client
errors were recorded.

`npm run visual-check` also passed against that URL: all four pages at 1536×864,
1440×900, 1000×800 and 390×844, repeated desktop chat focus, smaller-screen drawers,
mobile table-action reachability, INFY evidence/absence explanation and a simulated
chat transport failure that left core navigation working. The generated production
screenshots were visually inspected, including Home, Watchlist, Digest, Symbol
Detail and the mobile drawer; artifacts are in
`/private/tmp/thesis-redesign-production/` (not committed).

Observed production data differs from the locally seeded demo: the inspected INFY
page has a last-known quote but no usable stored history, statistics or event
evidence. The NIFTY summary query also has no stored quote. These are explicit empty
states/workspace context, not invented charts or values. No production seeding,
migration, schema, credentials, provider configuration or engine changes were made
as part of this UI pass. Populated historical event layouts were separately verified
against actual existing local demo evidence, clearly labeled DEMO REPLAY.

---

## Global market support (final polish pass)

**THESIS was an NSE product with a global tagline.** Search filtered on `.NS`,
`formatPrice` prepended `₹`, every timestamp rendered in IST, every beta was measured
against `^NSEI`, and the top bar said "MARKET CLOSED" for a whole watchlist. Searching
"BlackRock" answered "No NSE symbols found." The fix was not to delete the Indian
semantics — an NSE listing still needs rupees, IST and NIFTY — but to stop applying
them by default to everything.

**Security metadata is resolved in one place, from the provider.** `lib/securities.ts`
maps a symbol to its exchange, market, currency, exchange timezone and benchmark.
Yahoo returns all of it on every quote (`currency`, `exchangeTimezoneName`, an
exchange code), so provider metadata is authoritative and inference — exchange name,
then currency, then the `.NS`/`.BO` suffix — is only the fallback for rows written
before we captured it. A symbol we cannot place resolves to *unknown*: no currency
symbol, UTC labelled as UTC, no benchmark. It never silently becomes Indian.

**One additive migration.** `0008` adds a nullable `symbols.exchange_timezone`.
Nothing else changed: no symbol identity moved, no foreign key was touched, and every
existing user, watchlist, thesis and event row is untouched. Rows predating the column
carry NULL and resolve through inference until the next poll fills them in —
`ingestQuotes` now refreshes name, exchange, currency and timezone from the feed on
every poll, which is also how the eight seeded US symbols acquired their metadata.

**Benchmarks are regional, or absent.** Beta and the benchmark-relative residual are
computed against `^NSEI` for Indian securities and `^GSPC` for US ones. If a market's
index history is not stored, the residual signal is *withheld* and beta stays null,
with the symbol page saying which benchmark is missing. Comparing AAPL to NIFTY 50
would have produced a confident number about nothing — a fabricated signal is a worse
failure than an absent one.

**Sessions are stamped on the exchange's clock, DST included.** A daily event used to
be written at `${date}T10:00:00Z` — the NSE close, hardcoded. `zonedInstant` now
converts a trading date plus a local session time into an instant using the exchange's
zone, so a September NASDAQ close lands at 20:00Z and a December one at 21:00Z. It
reproduces exactly `10:00Z` and `03:45Z` for Asia/Kolkata, which is asserted in the
test suite: every already-stored Indian event keeps its identity, so nothing
duplicates or moves.

**Ordering matters, and the ingestion route already had it right.** Market metadata
comes from the quote feed, so `/api/ingest` polls before it detects. A symbol seeded
from a file but never quoted has no exchange recorded and would fall back to the
Indian session clock — which is exactly what happened once locally, and the 25 events
recorded in that state were deleted and re-derived after the first poll rather than
left to mislead.

**The US universe is eight names, not five hundred.** Statistics, detection, digest
and Replay are computed from *stored history*, and the deployed app never
cold-backfills. So the seeded universe defines what the product can genuinely reason
about: the NIFTY 50 set, both benchmarks, and AAPL, MSFT, NVDA, AMZN, GOOGL, TSLA,
JPM, BLK. Any other symbol the provider resolves can still be watched — it shows a
real price and real freshness, and says plainly that it holds no stored history yet
rather than rendering an empty chart with no explanation.

**Search is an allowlist, not everything Yahoo returns.** "Apple" resolves on XETRA,
Buenos Aires and São Paulo too. Each is a real security with a different currency,
calendar and benchmark, and offering it would advertise coverage nothing downstream
has been validated for. Search surfaces NSE, BSE, NASDAQ and NYSE; adding by ticker
stays open, because refusing a symbol the provider can quote would be a worse failure
than rendering it from its own metadata. The Indian name fallbacks stay and now rank
first: the provider still omits `INFY.NS` when you search "Infosys" and answers with
the NYSE ADR.

**Home became a market brief instead of a fourth dashboard.** Two rows of three
index cards on one grid — equal heights are a CSS fact, not a coincidence, and the
browser check asserts all six render one height. Each card shows the level, the point
and percent change, a sparkline or an explicit "History unavailable", and its own
exchange-local timestamp. Sparklines are drawn in a neutral tone deliberately: a
20-day line coloured red beside a green daily change is two claims in one card.
India and the US report session state separately ("INDIA CLOSED · US OPEN"), and when
the provider gives no state we show freshness rather than guess. `QuickNavigation`
was removed — it duplicated the sidebar — along with five dashboard widgets left
unreferenced by the earlier redesign.

**Appearance is Light and Dark.** "System" meant the same account could look
different on two machines with nobody having chosen either. A stored `system`
preference resolves to Dark and is rewritten on read, so no existing user is left on
a value the UI can no longer display.

**Verification.** `npm test` 142 assertions, `npm run smoke` 48 against the live
provider (including adding AAPL and BLK, both currencies in one watchlist, and
"BlackRock" → BLK/NYSE), `npm run browser-check` 59 checks end to end (global search
→ add → mixed-currency watchlist → US symbol detail → US thesis in dollars → Ask
THESIS), and the visual matrix across four viewports in both themes, which asserts
six equal-height index cards, both currencies in the watchlist table, and no ₹ or IST
anywhere on a US security's page. The local-only historical digest fixture
(`npm run visual-history-check`) is restricted by design to a local database and was
not runnable against the Neon URL in this pass; the missed-event session frame it
covers visually is asserted directly in the test suite instead.
