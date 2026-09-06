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

## Production result

Pending candidate deployment and canonical production verification. Local timings
and successful builds alone are not production sign-off.
