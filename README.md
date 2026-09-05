# Thesis

> A watchlist that remembers *why* you're watching.

Most watchlists read "what changed" as a property of the market: *this stock moved a
lot.* Thesis reads it as a property of your relationship with the stock: *something
changed that matters relative to why you cared about this one.*

When you add a symbol you can optionally record why. From then on the system does not
just monitor the stock — it monitors the reason it is on your list.

```
While you were away
  🔴 1 thesis contradicted
  🟢 2 conditions triggered
  ⚡ 1 event happened and reversed
  ○ 4 unchanged
```

Home is a concise Market Brief, not a second watchlist. The complete `/digest`
view preserves three kinds of updates a conventional
watchlist cannot express:

- **Condition met** — the thing you were waiting for happened.
- **Thesis contradicted** — the reasoning behind why you were watching no longer holds.
- **Missed event** — something crossed your threshold while you were away *and reversed
  before you got back*. A current-state app can never show you this.

---

## Status

Built for a 72-hour solo hackathon. This section is kept accurate as work lands.

**Deterministic foundation (local tests and prior production verification)**

- Email/password auth with server-side sessions (tokens stored hashed)
- One company search across NSE, BSE, NASDAQ and NYSE; add and remove from a watchlist
- Live prices, each shown with the exchange timestamp it was reported at and its age
- Scheduled ingestion behind a protected route — the only writer of quotes
- Append-only storage: daily bars, an intraday price path, per-symbol statistics
- `symbol_stats`: 20-day realized volatility, median volume, 20-day MA, 60-day beta
  vs the security's own market index, and 52-week / 20-day levels — all on the
  adjusted series, traded sessions only
- Corporate-action **detection** from provider-history restatement, with uniformity,
  tolerance and plausibility guards
- Feed resilience: batch reconciliation for silently dropped symbols, transient vs
  terminal miss classification, last-known-good serving
- Seeded history: 60 days of 5-minute bars for the Indian universe and 2 years of
  daily bars for 60 symbols across both markets, fetched locally and committed, so
  the deployed app never cold-backfills

**Also built**

- *Change engine* — deterministic anomaly detection and scoring on top of
  `symbol_stats`, with cooldown, hysteresis and transient-event resolution
- *Thesis engine* — optional structured reasons for watching, evaluated against
  stored market evidence without an AI dependency
- *Digest and symbol detail* — a "While you were away" view, evidence panels,
  missed-event replay, and a traceable per-symbol view
- *Authenticated workspace* — reference-led sidebar, global company search, dense
  watchlist, Add Stock dialog, dashboard and stored-history symbol charts
- *Ask THESIS* — dedicated `/ask` conversation: authenticated deterministic answers
  from stored THESIS context, plus optional server-side general finance education
- *THESIS Replay* — historical occurrences of price ranges and volume-confirmed
  breakouts, using shared deterministic predicates; never writes monitoring events

**Optional anomaly layer (machine learning)**

- Isolation Forest, implemented in TypeScript in `lib/ml/` — no Python service,
  no new deployment, no runtime dependency added
- Unsupervised and per security: each company's model is fitted on its own recent
  history, so "unusual" means "unlike this company", not "unlike other companies"
- Eight features drawn from data THESIS already stores; missing features are
  dropped as columns, never imputed with zero
- Fitted during scheduled ingestion, after every deterministic write has
  committed, and stored immutably with its model version, threshold, training
  window and the exact features it saw
- Categorical output — UNUSUAL / NORMAL / INSUFFICIENT_HISTORY / UNAVAILABLE —
  never a score, a rating or a prediction
- Secondary evidence throughout: no deterministic engine imports it, and the
  product is complete when it is absent

**Global market support**

- Company search across NSE, BSE, NASDAQ and NYSE from one index — the same search
  powers the top bar and Add Stock
- Per-security exchange, currency and timezone taken from provider quote metadata
  and persisted (`symbols.exchange_timezone`, additive migration `0008`)
- Native currency everywhere: ₹ on an NSE listing, $ on a US one, never converted
- Exchange-local freshness: a NASDAQ quote is never timestamped in IST, and a US
  security is not "closed" because the NSE is
- India and the US index rows on Home, each with its own session state and clock
- Regional benchmarks (`^NSEI` / `^GSPC`) for beta and benchmark-relative evidence,
  withheld rather than substituted when a market's index history is missing
- Deterministic detection, digest, thesis evaluation and Replay run unchanged on US
  securities: sessions are stamped at that exchange's close, DST included

This pass is locally verified against the live provider and a real browser;
production sign-off is recorded in [DECISIONS.md](DECISIONS.md). The additive
`0008` migration and the extended daily seed need to be applied to the production
database before deploying. General Q&A needs an API key.

## The product loop

DEFINE → TEST → MONITOR → DETECT → EXPLAIN → REMEMBER

| Surface | Its job |
|---|---|
| Home `/` | Market Brief: personalised greeting, NIFTY 50 / SENSEX / NIFTY BANK and S&P 500 / NASDAQ / Dow, each market's own session state and clock, a compact personal status strip, and current publisher headlines. No stock rows. |
| Watchlist `/watchlist` | Company management, last-known quotes, freshness, structured condition and status. Responsive cards below desktop table widths. |
| Digest `/digest` | What happened while away: stored triggers, contradictions, missed/reversed events, evidence and normal read receipts. |
| Company Detail `/symbol/[symbol]` | Any supported company, watched or not: identity, price, exchange freshness, ranged price history, market data, the anomaly layer's verdict, detected events and the Recorded Evidence captured when the latest one fired. Watched companies additionally show the original note, structured thesis, verdict timeline and THESIS Replay. |
| Ask THESIS `/ask` | Session conversation, separate THESIS DATA / GENERAL labels, contextual stock entry and helpful advice boundary. Never permanently embedded elsewhere. |

The top-right account menu addresses the user by their stored name — never their
email address, and never a name derived from one; an account created before names
existed reads "Account" and can supply a name from a single field in the dropdown.
The Home greeting uses the same stored name and the reader's own clock. The menu
offers exactly two appearances — Light and Dark — plus sign-out. The preference persists per
browser, and a preference stored before the third option was removed resolves to
Dark. New accounts store a validated display name; legacy names remain nullable and
fall back to a generic greeting.

### Search is discovery, not an add shortcut

The global search bar answers "what is this company doing", not "add this to my
list". Selecting a result opens that company's page — watched or not — so a user
can look before deciding whether the reason to watch it is worth writing down.
Adding starts from that page (or from the watchlist's own Add Stock button) and
runs through the one existing flow: symbol, optional structured condition,
optional note.

A company nobody watches still shows real market information: identity, exchange,
native currency, live price and freshness, a ranged price chart, the session's
open/high/low/volume where the source provides them, and any detected market
events. What it does not show is a thesis, a status, personal evidence or a
replay — those are facts about a user, and inventing them for a company they do
not watch is exactly the fabrication this product exists to avoid. It says so
instead, and offers the add.

Chart ranges are offered only where observations exist: 1D and 1W come from the
observed intraday path, 1M/3M/1Y from stored or provider daily bars. A security
we hold only daily bars for gets no 1D button rather than a line drawn between
two closes. For a company nobody watches yet, one cached, bounded, read-only
provider request supplies the quote and history — nothing is persisted, so this
is an interactive lookup rather than the cold backfill the deployed app is
forbidden from doing, and a provider failure degrades to "Price history
temporarily unavailable" with the rest of the page intact.

### The anomaly layer

Deterministic rules are excellent for known market conditions: a 2σ move, volume
at twice its median, a level crossed. What they cannot express is a combination
that is unremarkable in every individual dimension and unusual as a whole — a
modest move, on modest volume, against the market, away from the moving average,
on a day that gapped. The anomaly layer complements them by identifying unusual
*combinations* of otherwise individually ordinary signals.

**It is unsupervised, deliberately.** There is no reliable ground truth for
whether a market observation "matters" to every investor, so THESIS does not
train a supervised buy/sell classifier. Isolation Forest needs no labels: it
learns the shape of a security's ordinary behaviour and reports how easily a day
separates from it.

**It does not predict.** The model identifies unusual historical market states;
it does not forecast future returns, rank securities, or express a view on what a
price will do next. Its output is categorical for exactly that reason — there is
no score on any screen, because a number between 0 and 1 next to a company name
reads as a rating no matter what the label says.

**Explainability is stated honestly.** Isolation Forest gives no per-feature
attribution, so THESIS never claims one. The UI separates the model's single
claim ("this combination was unusual") from the observed evidence (price move,
standardized move, relative volume, benchmark residual, distance from the moving
average), and says in as many words that those signals are context rather than
causes.

| | |
|---|---|
| Model | Isolation Forest (Liu, Ting & Zhou, 2008), 100 trees, 256-row subsample, seeded |
| Features | daily return, standardized return, realized volatility, log relative volume, benchmark residual, distance from MA20, position in the 20-day range, gap return |
| Fitted on | that security's own last 250 feature rows, strictly before the evaluated session |
| Minimum history | 60 usable training rows and at least three available features |
| Threshold | the 99th percentile of the training scores — the security's own distribution |
| Runs | once per security per session, inside scheduled ingestion, after detection commits |
| Stored | `market_anomalies`: status, raw score, threshold, model version, data mode, feature snapshot, training-window metadata |

Every rolling input for a session — volatility, median volume, the moving
average, the 20-day range, beta — is computed from sessions strictly *before* it,
and the evaluated row is never part of its own training set. Evaluating an old
session therefore returns the same answer today as it would have on the day,
which is what makes stored anomaly evidence auditable rather than merely
re-derivable. Isolation Forest partitions on raw feature ranges, so nothing is
standardised and there is no fitted scaler that could leak future statistics.

If the model cannot fit, the layer records nothing: no badge, no section, no
event. Detection, thesis evaluation, the digest and Replay are unaffected, and
nothing in the deterministic pipeline reads the anomaly table.

### Two markets, one product

THESIS is not an NSE-only watchlist. Search covers NSE, BSE, NASDAQ and NYSE, and a
watchlist can hold `INFY.NS` in ₹ on Mumbai time next to `AAPL` in $ on New York
time. Nothing is converted or aggregated across currencies, no security is labelled
with another market's clock, and India and the US report their session states
separately — one "MARKET CLOSED" banner can only ever be true of one of them.

Every security's exchange, currency and timezone come from the provider's own quote
metadata (`lib/securities.ts` is the single place that resolves them, with inference
only as a fallback for rows written before the metadata column existed). Benchmark-
relative evidence is regional: `^NSEI` for Indian securities, `^GSPC` for US ones,
and **withheld entirely** when no index history is stored for that market rather
than measured against the wrong index.

See [DECISIONS.md](DECISIONS.md) for the reasoning, calibration record, and
intentional cut list.

---

## Setup

Requires Node 22+ (the installed Yahoo adapter requirement) and a Postgres database.

```bash
git clone https://github.com/tanisha-raha/thesis-market-watchlist.git
cd thesis-market-watchlist
npm install

cp .env.example .env.local        # then fill in the three values below
npm run db:migrate
npm run seed:load                 # loads committed history; makes no network calls
npm run dev                       # http://localhost:3000
```

`.env.local` needs three values:

| Variable | How to get it |
|---|---|
| `DATABASE_URL` | Any Postgres URL — see the Docker one-liner below |
| `SESSION_SECRET` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CRON_SECRET` | Any random string; only the ingestion route reads it |
| `OPENAI_API_KEY` | Optional server-only OpenAI key for GENERAL education; never put it in a `NEXT_PUBLIC_*` variable |
| `OPENAI_MODEL` | Optional model override; defaults to `gpt-4.1-mini` |

Current auth stores opaque random session-token hashes in Postgres; `SESSION_SECRET`
is a reserved legacy deployment variable, not the signing mechanism.

Seed data is committed to the repository, so a clean clone has two years of daily
bars and sixty days of 5-minute bars without touching the network.

A local Postgres via Docker, if you need one:

```bash
docker run -d --name thesis-pg \
  -e POSTGRES_PASSWORD=thesis -e POSTGRES_USER=thesis -e POSTGRES_DB=thesis \
  -p 55432:5432 postgres:17-alpine
# DATABASE_URL=postgres://thesis:thesis@localhost:55432/thesis
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run db:migrate` | Apply migrations |
| `npm test` | Database-backed and deterministic regression suite (needs `DATABASE_URL`) |
| `npm run smoke` | End-to-end against a real database and the live feed |
| `npm run browser-check -- [url]` | Signup, watchlist, thesis, chat, removal, logout/login persistence |
| `npm run visual-check -- [url] [output-directory]` | Screenshots and responsive interaction checks at 1536, 1440, 1000 and 390px; creates a test account |
| `npm run visual-history-check -- [local-demo-url] [output-directory]` | Populated digest screenshots from an isolated copy of existing demo evidence; local DB/server only; removes its own fixture account |
| `npm run validate:source` | Re-runs the Phase 0 data-source validation |
| `npm run seed:daily` / `seed:intraday` | Fetch history locally into `seed/` |
| `npm run seed:load` | Load committed seed files into the database |
| `npm run detect` | Run the deterministic change engine over loaded history |
| `npm run seed:demo` | Create the reproducible demo account and verify its digest |

### Scheduled ingestion

`/api/ingest` is the only writer of quotes. Point an external cron at it:

```
GET /api/ingest            Authorization: Bearer $CRON_SECRET   # every few minutes
GET /api/ingest?stats=1    Authorization: Bearer $CRON_SECRET   # once daily, after close
```

It refuses every request when `CRON_SECRET` is unset rather than failing open.

### Demo replay

After loading the committed seed, run:

```bash
npm run detect
npm run seed:demo
```

The script creates `demo@thesis.app` from the same stored bars and intraday
observations the application uses. It verifies that the digest contains a thesis
contradiction, a condition trigger, and a resolved intraday missed event. It does
not insert fabricated market events. Use the credentials printed by the script;
they are intentionally local/demo-only and should not be reused in production.

Set `THESIS_DATA_MODE=demo` on an explicitly demo-only server to label the shell,
quotes, and explanations **DEMO REPLAY**. The normal production deployment must not
use that flag. `npm run visual-history-check -- http://localhost:3102 /tmp/thesis-demo`
can inspect an existing local demo dataset using a disposable scoped account.
The script does not seed market history or fabricate events. A populated demo is
verified locally only; do not advertise production demo access until separately tested.

### THESIS Replay (distinct from DEMO REPLAY)

THESIS Replay is historical condition analysis, **not a prediction or an
investment-strategy backtest**. It describes the current user's saved condition over
up to 60 stored usable sessions. No returns, P&L, optimization or advice is produced.
It does not change thesis state, create events, or move read watermarks.

Supported: inclusive `price_range`, and `breakout` with the existing 1.5× median
volume confirmation. `lib/thesis-conditions.ts` is shared with monitoring. Price
ranges use the current provider close (not dividend-adjusted `adjClose`); breakout
uses the same adjusted-close basis as the thesis engine. The historical series is
provider-restated, not vendor-raw history. Pending validated corporate-action
reconciliation blocks Replay rather than comparing incompatible condition scales.

Consecutive qualifying daily closes form one observed occurrence; a subsequent
non-qualifying close resolves it. Displayed metrics: actual date window/session
count, occurrences, resolved occurrences, longest observed run, last occurrence,
median threshold distance and a date-only timeline. Entry already present at the
window start is explicitly left-censored. Data gaps/intraday paths remain unknown;
daily bars cannot prove same-session crossings or reversals. Today's potentially
unfinished daily bar is excluded. Fewer than two evaluable closes is insufficient;
breakouts first require 20 usable volume sessions. Other thesis types are explicitly
unsupported rather than given invented historical semantics.

DEMO REPLAY is different: deterministic provider infrastructure demonstrating real
stored event sequences. THESIS Replay analyzes a condition; DEMO REPLAY supplies a
demonstration dataset. Both use clear, separate labels.

### Presentation boundaries

`components/app-shell.tsx` supplies the sidebar, command/search bar and account menu.
`components/ui.tsx` and `dashboard-widgets.tsx` define shared cards, status,
freshness and evidence presentation, all parameterised by the security's currency
and exchange clock. `lib/presentation.ts` adds read-only queries for the user's
saved theses, stored daily closes and event evidence. Home never acknowledges a
digest; the existing `/digest` read receipt is unchanged. Historical charts omit
zero-volume bars and show their actual exchange date range, never an invented
intraday line. Evidence is timestamped separately from the latest quote. Index cards
make one small cached quote request through the existing live provider; stored
quotes are a last-known fallback. Sparklines prefer stored history and otherwise
make one cached, read-only chart request per index — nothing is persisted, and an
index with neither says "History unavailable" rather than showing empty space.
Failed or omitted indices stay truthful.

Market Briefing reads the Economic Times public Markets RSS feed: at most six
headlines from the last 72 hours, original publisher link/source/time, a 7-second
timeout, 256KB payload cap, no XML entities/DOCTYPE, and 10-minute public caching.
No article bodies, sentiment or causal attribution. News is presentation context
only and is never imported by detection, thesis evaluation, evidence or Replay.

### Deployment

Deployed as a single Next.js app on Vercel with Postgres on Neon.

1. Set `DATABASE_URL`, `SESSION_SECRET` and `CRON_SECRET` in the project's environment.
2. Run `npm run db:migrate` once against the production database.
3. Run `npm run seed:load` once against it too, from a local checkout. History is
   fetched locally and shipped as a committed file — the deployed app must never
   perform a cold historical backfill, because Yahoo throttles datacenter IPs far
   harder than residential ones.
4. Scheduling is split by cadence. `vercel.json` runs the daily statistics recompute
   after the NSE close, which fits within the Hobby plan's once-per-day cron limit.
   The ingestion route polls quotes before it detects, deliberately: a symbol's
   exchange and timezone come from the quote feed, and detection needs them to stamp
   a session in the right market's clock.
   Frequent quote polling runs from `.github/workflows/poll.yml` every ten minutes
   during market hours; it needs `INGEST_URL` and `CRON_SECRET` as repository secrets.

---

## Architecture

Next.js (App Router) + TypeScript, one deployable · Postgres · Drizzle · Tailwind ·
`yahoo-finance2`. Postgres is sufficient at this scale; choosing not to add a
time-series database is deliberate.

**Three separated layers.** *Detection* runs once per symbol regardless of how many
users watch it, which is what makes cost O(unique symbols) rather than
O(users × symbols). *Scoring* puts events in comparable units. *Personalisation*
filters by watchlist membership, thesis relevance and per-user watermark.

**Theses are structured and machine-verifiable.** Every trigger and contradiction is
evaluated deterministically against market data. A contradiction requires at least
2 of 3 independent conditions, so one noisy signal cannot fire it.

**Ask THESIS is an optional AI explanation layer over deterministic system outputs. It
does not detect events, determine thesis validity, or provide investment advice.** The
core product is deterministic and fully functional without AI. The AI layer is optional
presentation garnish, not a system dependency. The THESIS DATA mode uses a bounded,
read-only explanation path: it receives only the authenticated user’s relevant
watchlist, theses, digest output and recent evidence, never a database dump. It labels
explicit demo replay context and declines advice or prediction requests. GENERAL
uses an optional server-only OpenAI Responses API boundary (`store: false`, six
bounded conversation turns, 500 output tokens, 12-second timeout, no tools or DB
context). Responses are labeled GENERAL, never user evidence. Missing key, provider
errors and truncated responses have explicit degraded states. A best-effort
per-instance 8/minute/user guard complements—not replaces—provider spend limits.
THESIS-specific questions always use deterministic data, even in GENERAL selection.
Notes remain verbatim text and are not interpreted. No model can change an engine
decision, event, watermark or Replay result.

**Two storage facts that shaped the schema.** Yahoo returns no raw price series — its
`close` is already split-adjusted and is restated retroactively across all history
when a split occurs. So `price_bars` keeps what the provider said on the day
(`first_observed_*`, written once, never updated) separately from what it says now
(`current_provider_*`). The ratio between them *is* the split factor, so
corporate-action detection falls out of the storage design rather than needing a
feed we do not have.

**Every feed sits behind a provider interface** with `live` and `replay` adapters.
The replay adapter is not a test shortcut: it makes the demo reproducible when a free
API rate-limits us, and it models the provider's real failure modes rather than an
idealised feed.

---

## The clearest thing we can show you

**GRASIM.NS, 10 August 2026.** Its 52-week high was ₹3380.50. At 11:55 IST the price
crossed it, peaked at ₹3407.70, and fell back below at 14:15 — 140 minutes above a
52-week high, then gone.

**That day's closing price was ₹3380.50: exactly the level, not above it.**

On daily bars this event does not exist. Not smaller, not weaker — absent. A
watchlist built on daily closes tells you nothing happened. The same trace also
shows the hysteresis rule working: the price re-crossed the level at 14:30 without
having fallen through the re-arm band, and no duplicate event was emitted.

Full trace, including the stored event and every price tick, in
[docs/grasim-trace.md](docs/grasim-trace.md). It comes from the committed seed and
reproduces with `npm run detect`.

---

## Known limitations

- **Dividends are not adjusted for.** Splits are handled; dividend adjustment is
  deferred rather than half-done.
- **Sector-relative signals are not shipped.** Eleven NSE sector indices have usable
  history but `^CNXFIN` has none, so financials — a large slice of any Indian
  watchlist — would have no sector benchmark. One benchmark per market applied
  consistently beats a signal that silently does not apply to banks.
- **Only two markets are supported: India and the US.** Search is restricted to NSE,
  BSE, NASDAQ and NYSE. Any symbol the provider can quote can still be added by
  ticker and will render in its own currency and exchange time, but it has no
  regional benchmark and no seeded history.
- **A company outside the seeded universe has a lookup, not a monitor.** Its
  detail page shows a live quote and a provider-fetched chart, but nothing is
  stored, so it has no computed statistics, no detected events and no digest
  participation until it is watched and seeded.
- **A watched security outside the seeded universe has quotes but no history.** The
  deployed app never cold-backfills, so statistics, detection, digest events and
  Replay only exist for symbols whose daily bars were seeded from a local checkout
  (the NIFTY 50 set plus eight US names and both benchmarks). Any other symbol shows
  its price and freshness and says plainly that it has no stored history yet —
  `npm run seed:daily && npm run seed:load` extends that set.
- **Intraday history is Indian-only.** The committed 5-minute seed covers the NSE
  universe, so US missed-event detection depends on live polling accumulating an
  intraday path rather than on seeded history.
- **Market Briefing is India-focused.** The headline feed is an Indian markets RSS
  feed, labelled as such. THESIS does not claim comprehensive global news coverage.
- **Session counts across mixed markets are approximate.** "N trading sessions in
  this window" is derived from observed bars across everything a user watches; on a
  date where one market trades and the other does not, the count can be off by one.
  It is a sentence about the window, never an input to a verdict.
- **Intraday resolution is 5 minutes.** A threshold crossing that reverses inside a
  single 5-minute bar is below our detection resolution and we do not claim otherwise.
- **52-week levels are computed from adjusted closes, not intraday highs and lows.**
  The provider gives us no adjusted high or low, and mixing an unadjusted intraday
  high with an adjusted close would be incoherent across a split.
- **Throttling behaviour from the deployed host is not characterised.** 250 sequential
  requests from a residential IP produced no failures, but Yahoo throttles datacenter
  IPs harder and that test cannot speak for the deployment. The circuit breaker,
  replay adapter and never-cold-backfill rule are all treated as mandatory regardless.
- **The anomaly layer flags roughly one session in a hundred, by construction.**
  The threshold is the 99th percentile of a security's own training scores, so a
  quiet security still produces occasional flags and a volatile one needs more to
  stand out. That is the intended meaning — "unusual for this company" — and not
  a claim about significance.
- **Anomaly evidence exists only for monitored securities.** A company looked up
  but never watched has no stored history to fit on, so the Market Pattern
  section is omitted rather than estimated.
- **The Home greeting is computed on IST**, not on the viewer's local clock. It is
  rendered on the server, and a client-side clock would flash the wrong greeting
  before correcting itself; every market-data timestamp is exchange-local regardless.
- **Free-tier market data is delayed** and is presented with its exchange timestamp
  rather than as real-time.

---

## Statements we stand behind

> The core product is deterministic and fully functional without AI. The AI layer is optional presentation garnish, not a system dependency.

> The anomaly layer is an optional analytical layer, not the LLM layer above. It is
> real unsupervised machine learning on real stored observations, it is secondary
> evidence to the deterministic engine, and the product is complete without it —
> no deterministic module imports it, and its absence changes nothing a user
> depends on.

> Theses are structured and machine-verifiable rather than free-text. We never ask a
> language model whether a user's reasoning still holds — every trigger and
> contradiction is evaluated deterministically against market data.

> We intentionally excluded news-based cause attribution because unreliable entity
> matching and timestamp alignment could create false explanations. We preferred
> defensible quantitative evidence over speculative causality.

> Thesis is an attention tool, not an advisory product. It reports changes to
> conditions the user defined. It does not make recommendations.

Nothing in this application is investment advice. See [DECISIONS.md](DECISIONS.md)
for the reasoning behind every significant trade-off, and [reports/phase0.md](reports/phase0.md)
for the data-source validation the architecture rests on.
