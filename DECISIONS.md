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
4. **Missed-event replay UI** (the timeline view). **Keep the data** — keep
   `resolved_at`, keep detection, keep the events queryable. Only the rendered
   timeline goes, and the digest can still state that a missed event occurred.

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
