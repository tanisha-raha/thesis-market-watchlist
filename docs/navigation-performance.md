# Production navigation investigation — 6 September 2026

## Baseline and cause

Measured Chromium at 1536 × 864, real authenticated clicks from India against
`https://thesis-market-watchlist.vercel.app`. A disposable account watched INFY.NS;
BLK was inspected through global search without adding it. Three repeated warm
rounds, no artificial sleeps, no provider fixtures. Baseline deployment
`dpl_GLweKqkxCBQcviXm3N8816AGugm2` reports source `f735226`; its source tree is
identical to local `eb0cb39` (the previous performance pass).

| Navigation | Baseline first UI / usable, median (range), ms |
| --- | ---: |
| Home → Watchlist | 1,161 (1,155–1,178) |
| Watchlist → Home | 1,174 (1,154–1,189) |
| Home → Digest | 1,849 (1,836–1,884) |
| Digest → Watchlist | 4,782 (1,197–4,976) |
| Watchlist → watched INFY | 6,227 (4,289–6,277) |
| Symbol → Watchlist | 1,312 (1,158–5,095) |
| Search → unwatched BLK | 2,318 (2,294–3,980) |

Re-measured immediately before the fix against the same canonical deployment,
three warm rounds: Home → Watchlist 1,133–1,241 ms; Watchlist → Home 1,161–1,195;
Home → Digest 1,777–1,858; Digest → Watchlist 1,137–4,999; Watchlist → watched
Symbol 4,554–7,835; Symbol → Watchlist 1,126–1,224; Search → unwatched Symbol
2,246–2,379. Server TTFB was 232–349 ms and every response was served by
`bom1::iad1`.

The preceding independent three-round baseline also reproduced 1.13–1.23 s
Watchlist/Home, 1.81–1.84 s Digest, 4.70–4.93 s leaving Digest, and 6.05–6.15 s
watched Symbol Detail. This was not a single cold request.

Click → request start was 0–5 ms; TTFB 232–342 ms. Early RSC headers were **not**
destination UI. Home's remaining panels took another 1,617–1,618 ms after its
greeting appeared. The other sampled destinations had their visible sections
complete at first UI. Some browser RSC transfers did not report EOF when their
visible content completed: the probe reports `end: null`, not a made-up stream
completion. Observed completed compressed responses were small (about 2–10 KB),
not evidence of a large-payload bottleneck.

A behavior-identical, unpromoted diagnostic deployment (`dpl_M7NsBe1opJyLwmnpMFxQTVRdG8eE`)
enabled existing `THESIS_TRACE` timings. Its credential-free runtime metadata proved:

- Vercel functions: `iad1`, Northern Virginia.
- Existing pooled Neon database: `ap-southeast-1`, Singapore.
- Warm individual session/watchlist/presentation reads: approximately 430–455 ms.
- Watchlist server path: 902–904 ms; Digest: 1,567 ms.
- Watched Symbol path: 3,977 ms, including 1,966 ms for sequential replay reads.
- Home server path: approximately 887–902 ms, with some connection/queue outliers.
- Public Yahoo cache hits during that diagnostic: 5–34 ms.

The dominant measured cost was cross-continent database access multiplied by
dependent read stages. Some reads queued behind the small connection pool;
moving database-adjacent computation to the database region addresses this
without increasing connection counts or weakening session validation.

## Changes and preserved semantics

- Deploy functions in `sin1`, next to the **existing** Neon database. No database
  move, schema changes, migrations, or data recreation.
- An authenticated route-group layout owns the existing shell. It persists on
  sibling navigation; pages publish fresh user-scoped chrome snapshots. Every
  page/action still checks the existing session. React request memoization is
  retained; there is no shared cache of identity/watchlists/digests.
- A prefetchable route loading boundary covers **all** page reads, including the
  previously blocking first-ever company quote lookup. Market/history/news
  sections still stream with their existing truthful placeholders. No ingestion,
  detection, model fitting, or stats recomputation was added to navigation.
- Global search uses Next Links with unchanged appearance. Main links were
  already Next Links; there was no middleware and no ordinary router refresh.
  `force-dynamic` remains intentional for private pages.
- Digest acknowledgement uses a same-origin authenticated JSON POST, outside
  Next's server-action queue. It calls the same monotonic, completed-batch-clamped
  write as the existing action. A transport failure leaves the digest unread.
  There was no proof that action queuing alone explained all outliers; region
  latency was independently measured. A held-receipt browser regression verifies
  that it cannot block subsequent navigation.
- The route group's symbol invalidation pattern is updated. Authentication,
  mutation logic, provider caches, deterministic calculations, and visual design
  otherwise remain unchanged.

## Second pass — round trips, not just their length

Co-location makes a round trip cheap; it does not make a chain of them free, and
the chains were the reason one page cost several times another. Counting the
*dependent* database stages a navigation waits on, before and after:

| Navigation | Dependent stages before | after |
| --- | ---: | ---: |
| Watchlist / Home | 2 | 2 |
| Digest | 2 | 2 |
| Watched Symbol Detail | 8 | 3 |
| Unwatched company (search) | 5 + provider quote | 2 + provider quote |

- `getThesisReplay` chained membership → pending corporate action → exchange
  metadata → bars. Only the membership check gates the rest, so the other three
  are now issued together and today's session is excluded in TypeScript against
  the same exchange date the SQL predicate used. Tests assert the window still
  ends on the previous session and still walks 60 sessions.
- `getCompanyView` waited to learn whether a symbol was tracked before reading
  its bars and intraday observations — a second serial trip bought to skip two
  queries that return nothing for an unknown symbol. All six stored reads now go
  out at once.
- The company page's verdict query was scoped by the thesis id it had just
  fetched. It is scoped by watchlist membership in the query itself instead, which
  returns the same rows one stage earlier.
- Detected events, the thesis timeline, recorded evidence, the replay walk and
  the anomaly classification moved below their own Suspense boundaries. Identity,
  the latest persisted price, the chart and the user's own thesis — the reason
  somebody opened the company — are still awaited before the page is sent.
- Company search answers from the stored catalogue first and merges the provider's
  results behind it, so a seeded company does not wait on a datacenter round trip
  to Yahoo. The provider still runs, still supplies everything the catalogue does
  not know, and keeps its sixty-second cache; when local matches already exist its
  budget is short, and a timeout shows the real local rows rather than an invented
  one. Indices are excluded, exactly as the provider path filters to equities.

Nothing here recomputes a market fact. No fit, no backfill, no detection and no
statistics run on a navigation; every streamed section reads rows that ingestion,
detection or the anomaly run already committed.

## Production result

Promoted to the canonical alias as deployment `dpl_6ALyyYxNGHZVWLnUn2DCZwUFUwbr`,
functions in `sin1`. Three warm rounds against
`https://thesis-market-watchlist.vercel.app`, same probe, same viewport, same
account shape, no client errors:

| Navigation | First destination UI, ms | Usable, ms | Fully settled, ms |
| --- | ---: | ---: | ---: |
| Home → Watchlist | 14–15 | 313–314 | 313–314 |
| Watchlist → Home | 12–15 | 316–319 | 316–319 |
| Home → Digest | 14–15 | 314–316 | 314–316 |
| Digest → Watchlist | 13–14 | 313–315 | 313–315 |
| Watchlist → watched Symbol | 12–14 | 313–320 | 313–320 |
| Symbol → Watchlist | 12–14 | 313–315 | 313–315 |
| Search → unwatched Symbol | 10–13 | 312–314 | 312–313 |

Server TTFB was 114–140 ms throughout, and the same three rounds against the
unpromoted candidate (`thesis-nav-candidate.vercel.app`, protection bypassed in
memory) produced the same figures — the promotion changed which alias serves the
build, not the build. The one cold sample worth naming is the first uncached
provider lookup for a company nobody watches: 1,134 ms on the candidate's first
round, 312 ms once its result was cached, and it happens below the route loading
boundary rather than in front of it.

The remaining ~300 ms between the destination shell and usable content is not
database time: an identical local production build against a local database
measures the same 312–321 ms. It is the dynamic render and RSC delivery of the
page itself, and it is what the loading boundary now covers.

## Reproducing

```sh
npm run navigation-check -- https://thesis-market-watchlist.vercel.app
NAV_ASSERT=1 npm run navigation-check -- http://localhost:3100
```

`NAV_ROUNDS` defaults to three. `NAV_ASSERT=1` additionally requires warm first UI
below 500 ms, a persistent shell, no full reloads, navigation with a stalled receipt,
and receipt authentication/origin/input guards. Click/UI/content-settled timestamps
are sampled in the browser, not inferred from Playwright polling delays. It creates
an isolated test account and one watchlist membership; it never substitutes prices
or records cookies/passwords/connection strings. Optional deployment-protection
bypass is passed in memory only. `THESIS_TRACE=1` logs route/read durations and
region labels, never the database hostname or URL.
