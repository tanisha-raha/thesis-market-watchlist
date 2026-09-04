# Phase 0 — data source validation

Run 2026-09-04, 11:30 IST (market open, `marketState: REGULAR`), from a residential IP.
`yahoo-finance2@4.0.2`, Node 24. Raw output: `reports/phase0.json`, `reports/phase0-followup.json`.
Scripts: `scripts/validate-source.ts`, `scripts/validate-followup.ts`.

**Verdict: yahoo-finance2 is viable. Proceed. No fallback to NSE bhavcopy needed.**
Two findings change the schema; one changes the deployment plan.

---

## 1. RELIANCE.NS daily OHLCV, 90 days — PASS

65 bars, 2026-06-08 → 2026-09-04. 65 weekdays in the window, so the calendar is complete once
holidays are accounted for. Zero nulls across open/high/low/close/volume/adjclose. No gaps > 3
calendar days. Currency INR, timezone Asia/Kolkata, exchange NSI.

One artifact: **2026-06-26 has a real close (₹1318.10) and `volume: 0`.** Not a null — a zero.
Any volume-ratio signal must guard against divide-by-zero and against treating this as a genuine
volume collapse.

## 2. ^NSEI alignment — PASS

65 bars, exactly the same 65 trading days. Zero dates in one series and not the other. Beta and
residual computation can join on date with no interpolation.

Index bars carry `volume: 0` (expected — it is an index). Volume signals must be equity-only.

## 3. Split adjustment — PASS, but with a consequence

Rather than trusting a remembered split, the script scanned 16 NSE symbols over 4 years and found
8 real splits. Verified the three most recent:

| Symbol | Date | Ratio | Return across split, adjusted series | Return if series were raw |
|---|---|---|---|---|
| TRENT.NS | 2026-06-04 | 3:2 | −0.03% | −33.33% |
| HDFCBANK.NS | 2025-08-26 | 2:1 | −0.88% | −50.00% |
| NESTLEIND.NS | 2025-08-08 | 2:1 | −1.86% | −50.00% |

Every adjusted series is continuous across the split — normal daily returns, not an 80% phantom
crash. The adjustments are correct. The brief's warning did not reproduce on these cases.

**But the important finding is what `close` actually is.** I asked for 2024-11-05 twice: once from
a window starting *after* RELIANCE's 2024-10-28 2:1 split, once from a window spanning it. Both
returned `close = 1305.30`, identical.

So **Yahoo returns no raw price series at all.** `close` is already split-adjusted and is
retroactively restated the moment a split occurs; `adjclose` differs from it only by dividends
(ratio over 2y: 0.99144 → 1.00000, tracking the two RELIANCE dividends in the window).

Consequence for the schema: `price_bars.raw` cannot mean "what the provider calls raw", because
the provider has none. It has to mean **as-observed at ingestion time** — the price we saw and
stored on that day, immutable thereafter. That is the only raw record we will ever hold, and it is
precisely what makes the corporate-actions work detectable: on the next ingest the provider's
history for a bar we already stored will have changed, and the ratio between the two *is* the split
factor. It also sharpens why the brief's watermark-and-thesis-parameter adjustment matters — the
user's stored ₹2,800 does not move on its own, but the entire price history underneath it does.

## 4. NSE sector indices — MOSTLY PASS

Over 2 years: `^NSEBANK` `^CNXIT` `^CNXAUTO` `^CNXPHARMA` `^CNXFMCG` `^CNXMETAL` `^CNXENERGY`
`^CNXREALTY` `^CNXPSUBANK` `^CNXINFRA` `^CNXMEDIA` all return 501 bars — enough for a 60-day
rolling beta.

`^CNXFIN` returns 1 bar (today only) — unusable. `NIFTY_FIN_SERVICE.NS` likewise.

A 30-day request returns only 1 bar for several of these while a 730-day request returns 501 — the
short window is unreliable, the long one is not. **Always request the long window and slice
locally.** This would have silently produced garbage betas if I had only run the 30-day check.

Sector-relative signals are viable, but financials have no sector index. NIFTY-relative remains the
primary signal per the brief; sector-relative stays a stretch goal.

## 5. Throttling — NO LIMIT REACHED from this IP

- 60 sequential quotes: 60/60 ok, 4.0s, 15.0 req/s
- 250 sequential quotes: 250/250 ok, 24.2s, 10.3 req/s, zero failures
- 20 concurrent chart requests: 19/20 in 880ms (the one failure was a genuinely dead symbol)
- **`quote(string[])` batches: 50 symbols in one HTTP request, 3.8s**

No 429, no backoff, no error shape to design against — I could not make it fail. That is a
*negative* result and I am treating it as one: the brief's warning is that Yahoo throttles
datacenter IPs far harder than residential ones, and this machine is residential. **This test
cannot tell us what Vercel will see.** The circuit breaker, the replay adapter, and the
never-backfill-on-deploy rule all stay mandatory.

The batched quote is the useful finding: a 50–100 symbol universe is 1–2 HTTP requests per poll,
not 50–100. That alone probably keeps us under whatever ceiling exists.

**Resilience finding, and a nasty one:** batched quote **silently drops** symbols it cannot
resolve. 50 requested → 49 returned, no error, no null, no indication which one vanished
(`TATAMOTORS.NS` — no longer resolving, consistent with the Tata Motors demerger). A mixed batch of
`[RELIANCE.NS, NOTAREALSYMBOL.NS, TCS.NS]` returns 2 results and throws nothing. Ingestion must
reconcile requested against returned by symbol and treat a missing symbol as a stale-data event —
otherwise a delisted or renamed symbol goes quiet forever and the user is never told.

## 6. Live quote staleness metadata — PASS

84 fields. The ones that matter:

| Field | Value |
|---|---|
| `regularMarketTime` | 2026-09-04T06:01:27Z (**6s old** when measured) |
| `marketState` | `REGULAR` |
| `exchangeDataDelayedBy` | 15 |
| `sourceInterval` | 15 |
| `quoteSourceName` | Free Realtime Quote |
| `exchangeTimezoneName` | Asia/Kolkata |
| `hasPrePostMarketData` | false |

`regularMarketTime` is a real exchange timestamp, so freshness is `now − regularMarketTime` — we do
not have to invent it. `marketState` gives us the brief's "market closed since your last visit"
distinction directly, rather than inferring it from a holiday calendar.

Note the contradiction: `exchangeDataDelayedBy: 15` (minutes) against a measured 6-second age.
The advertised delay is the conservative number and the observed freshness is better. **The UI
shows the observed `regularMarketTime`, and never claims real-time.**

`quote.corporateActions` exists but returned `[]` — not a usable split feed. Splits come from
`chart(..., { events: "div|split" })`, which is where the verified data in §3 came from.

## Bonus — intraday availability (not asked, but it gates missed-event replay)

The missed-event feature needs sub-daily resolution, so I checked retention:

| Interval | Window | Result |
|---|---|---|
| 1h | 730d | 3500 bars ✓ |
| 5m | 60d | 3302 bars ✓ |
| 1m | 7d | 1876 bars ✓ |
| 1m | 30d | ✗ "Only 8 days worth of 1m granularity data" |

1h over 2 years is plenty for the change engine's hourly window and for supersession. 5m over 60
days is more than enough for the replay timeline. 1m is capped at ~8 days — fine, we do not need it.

---

## What I recommend changing in the plan

1. **`price_bars` stores as-observed bars, not "raw" bars.** The provider has no raw series. Keep
   `close_as_observed` immutable at ingest and let `close_adj` be refreshed from the provider;
   their divergence is our split detector.
2. **Poll with batched `quote(string[])`**, ~50 symbols per call. Cuts the deployed request rate by
   ~50× and is the single cheapest thing we can do about the Vercel IP risk.
3. **Reconcile batch responses by symbol.** A silently-dropped symbol is a stale-data event, not a
   no-op. This is a real edge case with a real cause (demergers) and it is worth a line in the README.
4. **Always fetch long windows and slice locally** — short windows return 1 bar for several sector
   indices without erroring.
5. **Guard volume signals** against `volume: 0` bars, which occur on real trading days.
6. **`^CNXFIN` is unusable.** If we do sector-relative at all, financials fall back to NIFTY.
7. The throttle test is **inconclusive by construction**, not clean. Nothing about the resilience
   plan relaxes on the strength of it.
