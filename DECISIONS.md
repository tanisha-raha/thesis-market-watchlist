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
