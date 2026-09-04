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

*That digest is where the product is going — see **Status** below for what is built
today.* Three kinds of news a conventional watchlist cannot express:

- **Condition met** — the thing you were waiting for happened.
- **Thesis contradicted** — the reasoning behind why you were watching no longer holds.
- **Missed event** — something crossed your threshold while you were away *and reversed
  before you got back*. A current-state app can never show you this.

---

## Status

Built for a 72-hour solo hackathon. This section is kept accurate as work lands.

**Built and verified end to end**

- Email/password auth with server-side sessions (tokens stored hashed)
- Symbol search across NSE, add and remove from a watchlist
- Live prices, each shown with the exchange timestamp it was reported at and its age
- Scheduled ingestion behind a protected route — the only writer of quotes
- Append-only storage: daily bars, an intraday price path, per-symbol statistics
- `symbol_stats`: 20-day realized volatility, median volume, 20-day MA, 60-day beta
  vs NIFTY, and 52-week / 20-day levels — all on the adjusted series, traded sessions only
- Corporate-action **detection** from provider-history restatement, with uniformity,
  tolerance and plausibility guards
- Feed resilience: batch reconciliation for silently dropped symbols, transient vs
  terminal miss classification, last-known-good serving
- Seeded history: 60 days of 5-minute bars and 2 years of daily bars for 51 symbols,
  fetched locally and committed, so the deployed app never cold-backfills

**In progress**

- *Change engine* — anomaly detection and scoring on top of `symbol_stats`, with
  cooldown, hysteresis and transient-event resolution
- *Thesis engine* — capturing why you are watching, then evaluating triggers and
  contradictions deterministically against market data
- *Digest* — the "While you were away" surface, evidence panels, and the
  missed-event replay

The data model for all three is in place and populated; see [DECISIONS.md](DECISIONS.md)
for the reasoning and the recorded cut list.

---

## Setup

Requires Node 20+ and a Postgres database.

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
| `npm test` | The five integration tests (needs `DATABASE_URL`) |
| `npm run smoke` | End-to-end against a real database and the live feed |
| `npm run browser-check [url]` | Drives the UI in a real browser |
| `npm run validate:source` | Re-runs the Phase 0 data-source validation |
| `npm run seed:daily` / `seed:intraday` | Fetch history locally into `seed/` |
| `npm run seed:load` | Load committed seed files into the database |

### Scheduled ingestion

`/api/ingest` is the only writer of quotes. Point an external cron at it:

```
GET /api/ingest            Authorization: Bearer $CRON_SECRET   # every few minutes
GET /api/ingest?stats=1    Authorization: Bearer $CRON_SECRET   # once daily, after close
```

It refuses every request when `CRON_SECRET` is unset rather than failing open.

### Deployment

Deployed as a single Next.js app on Vercel with Postgres on Neon.

1. Set `DATABASE_URL`, `SESSION_SECRET` and `CRON_SECRET` in the project's environment.
2. Run `npm run db:migrate` once against the production database.
3. Run `npm run seed:load` once against it too, from a local checkout. History is
   fetched locally and shipped as a committed file — the deployed app must never
   perform a cold historical backfill, because Yahoo throttles datacenter IPs far
   harder than residential ones.
4. Scheduling is split by cadence. `vercel.json` runs the daily statistics recompute
   after NSE close, which fits within the Hobby plan's once-per-day cron limit.
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

## Known limitations

- **Dividends are not adjusted for.** Splits are handled; dividend adjustment is
  deferred rather than half-done.
- **Sector-relative signals are not shipped.** Eleven NSE sector indices have usable
  history but `^CNXFIN` has none, so financials — a large slice of any Indian
  watchlist — would have no sector benchmark. One benchmark applied consistently
  beats a signal that silently does not apply to banks. NIFTY-relative is used
  throughout.
- **Intraday resolution is 5 minutes.** A threshold crossing that reverses inside a
  single 5-minute bar is below our detection resolution and we do not claim otherwise.
- **52-week levels are computed from adjusted closes, not intraday highs and lows.**
  The provider gives us no adjusted high or low, and mixing an unadjusted intraday
  high with an adjusted close would be incoherent across a split.
- **Throttling behaviour from the deployed host is not characterised.** 250 sequential
  requests from a residential IP produced no failures, but Yahoo throttles datacenter
  IPs harder and that test cannot speak for the deployment. The circuit breaker,
  replay adapter and never-cold-backfill rule are all treated as mandatory regardless.
- **Free-tier market data is delayed** and is presented with its exchange timestamp
  rather than as real-time.

---

## Statements we stand behind

> The core product is deterministic and fully functional without AI. The AI layer is
> optional presentation garnish, not a system dependency.

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
