# The GRASIM trace

The clearest evidence that missed-event detection requires an intraday price path.
Real data from the committed seed, reproducible with `npm run detect`.

**GRASIM.NS — Monday 10 August 2026.** 52-week high (adjusted closes): **₹3380.50**.
Re-arm band, 0.5% below: **₹3363.60**.

| IST | Price | State |
|---|---|---|
| 11:50 | ₹3376.70 | below the level |
| **11:55** | **₹3385.20** | **crosses — event opens, `occurred_at` set** |
| 13:35 | ₹3407.70 | intraday peak, ₹27.20 above the level |
| 14:10 | ₹3392.10 | still above |
| **14:15** | **₹3371.00** | **falls back — `resolved_at` set. Open for 140 minutes** |
| 14:25 | ₹3376.20 | below the level but *above* the re-arm band |
| 14:30 | ₹3387.40 | back above the level — **no second event** |

## Why this matters

**The daily close that day was ₹3380.50 — exactly the 52-week level, not above it.**

So on daily bars this event does not exist. Not smaller, not weaker, not a
near-miss: absent. A watchlist built on daily closes reports that nothing happened
on a day when the stock spent 140 minutes at a 52-week high and gave it all back.

That is the entire argument for storing an intraday price path, and it is why the
5-minute seed was fetched before anything else in the build.

## What else it demonstrates

**Hysteresis.** The price re-crossed the level at 14:30, but between 14:15 and 14:30
it never fell through the re-arm band at ₹3363.60. So the crossing did not re-arm
and no duplicate event was emitted. This is the brief's 100.01 / 99.99 / 100.02 case
occurring naturally in real data.

**`resolved_at` is when the condition ceased to hold** — 14:15, when the price fell
back below ₹3380.50 — and not when it later re-armed. Those are deliberately
different instants: resolution answers "when did this reverse", which is what the
user is owed; re-arming only gates whether a *new* event may open.

## The stored event

```
symbol       GRASIM.NS
signal_type  cross_52w_high
window       intraday
occurred_at  2026-08-10 11:55 IST
resolved_at  2026-08-10 14:15 IST
magnitude    0.00139        (fraction above the level at the moment it fired)
```

An event like this, whose whole span falls inside a user's away-window, is a
**missed event** — the one thing a current-state application can never show.
