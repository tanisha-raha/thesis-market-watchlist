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
