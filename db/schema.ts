import {
  pgTable, text, timestamp, integer, numeric, uniqueIndex, index, serial, date,
} from "drizzle-orm/pg-core";

/**
 * TIMEZONE DISCIPLINE — applies to every column in this file.
 *
 * Every instant is `timestamp with time zone`, stored and compared in UTC.
 * IST exists only at the rendering boundary (lib/time.ts). No column ever holds
 * a naive local time. Trading *dates* are the one exception: they are calendar
 * dates in IST, stored as `text` in YYYY-MM-DD form, because "the 2026-09-04
 * session" is a market-calendar fact, not an instant, and converting it to a
 * timestamp invites an off-by-one across the UTC/IST boundary.
 */

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("users_email_idx").on(t.email)]);

export const sessions = pgTable("sessions", {
  // SHA-256 of the cookie token. We never store the token itself, so a database
  // leak does not hand over live sessions.
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/**
 * One row per unique symbol, shared across all users. The change engine will run
 * per row here, not per watchlist item — that is the fan-out property that makes
 * cost O(unique symbols) rather than O(users × symbols).
 */
export const symbols = pgTable("symbols", {
  symbol: text("symbol").primaryKey(),          // Yahoo form, e.g. RELIANCE.NS
  name: text("name"),
  exchange: text("exchange"),
  currency: text("currency"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // --- feed health -------------------------------------------------------
  // Batched quote() silently drops symbols it cannot resolve (Phase 0 finding).
  // We count consecutive misses so a one-poll blip stays invisible while a real
  // delisting or rename eventually surfaces. See lib/feed-health.ts.
  lastSeenInFeedAt: timestamp("last_seen_in_feed_at", { withTimezone: true }),
  consecutiveFeedMisses: integer("consecutive_feed_misses").notNull().default(0),
});

/**
 * Latest known quote per symbol. Deliberately a separate table from `symbols`:
 * quotes churn on every poll, symbol identity does not.
 *
 * `asOf` is the exchange's own timestamp (`regularMarketTime`), NOT our fetch
 * time — freshness is a property of the data, not of when we asked for it.
 */
export const quotes = pgTable("quotes", {
  symbol: text("symbol").primaryKey().references(() => symbols.symbol, { onDelete: "cascade" }),
  price: numeric("price", { precision: 18, scale: 4 }).notNull(),
  previousClose: numeric("previous_close", { precision: 18, scale: 4 }),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  marketState: text("market_state"),            // REGULAR | CLOSED | PRE | POST ...
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const watchlistItems = pgTable("watchlist_items", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  symbol: text("symbol").notNull().references(() => symbols.symbol, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // A user cannot watch the same symbol twice. Enforced in the database, not in
  // application code, because two concurrent add requests would both pass a
  // read-then-write check.
  uniqueIndex("watchlist_user_symbol_idx").on(t.userId, t.symbol),
]);

/**
 * One row per ingestion run. `completedAt` is load-bearing: the digest cutoff is
 * the completion timestamp of the last fully-committed batch, never `now()`.
 * Using `now()` would skip any event whose `detectedAt` precedes the cutoff but
 * which commits after the digest query runs.
 */
export const ingestionBatches = pgTable("ingestion_batches", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(),                 // STARTED | COMPLETED | FAILED
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  requestedCount: integer("requested_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  missingCount: integer("missing_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
  failureSummary: text("failure_summary"),
});

/**
 * Daily bars, holding two distinct things.
 *
 * `firstObserved*` is what the provider told us the first time we saw this bar,
 * written once and never updated. `currentProvider*` is the provider's present
 * opinion, refreshed on every ingest.
 *
 * They diverge for a reason. Phase 0 proved Yahoo returns no raw series: `close`
 * is already split-adjusted and is restated retroactively across all history
 * when a split occurs. So "raw" can only mean "as observed by us on the day",
 * and the ratio between the two columns IS the split factor — corporate-action
 * detection falls out of the storage design rather than needing a separate feed.
 */
export const priceBars = pgTable("price_bars", {
  symbol: text("symbol").notNull().references(() => symbols.symbol, { onDelete: "cascade" }),
  tradingDate: date("trading_date", { mode: "string" }).notNull(),

  firstObservedClose: numeric("first_observed_close", { precision: 18, scale: 4 }),
  firstObservedVolume: numeric("first_observed_volume", { precision: 22, scale: 0 }),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
  firstObservedBatchId: integer("first_observed_batch_id").notNull().references(() => ingestionBatches.id),

  currentProviderClose: numeric("current_provider_close", { precision: 18, scale: 4 }),
  currentProviderAdjClose: numeric("current_provider_adj_close", { precision: 18, scale: 4 }),
  currentProviderVolume: numeric("current_provider_volume", { precision: 22, scale: 0 }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull(),
  refreshedBatchId: integer("refreshed_batch_id").notNull().references(() => ingestionBatches.id),
}, (t) => [uniqueIndex("price_bars_symbol_date_idx").on(t.symbol, t.tradingDate)]);

/**
 * Append-only intraday price path. This is what makes a missed event visible:
 * an event that fired and reversed while the user was away leaves no trace in
 * current state, only in the sequence of observations.
 *
 * `source` records how a point was obtained. `poll` is a point sample from a
 * live quote; `bar_5m` is the close of a seeded 5-minute bar. Both are prices at
 * an instant and the detector reads them as one series, but they are not the
 * same kind of measurement and the column keeps that honest rather than
 * silently conflating them.
 */
export const quoteObservations = pgTable("quote_observations", {
  id: serial("id").primaryKey(),
  batchId: integer("batch_id").notNull().references(() => ingestionBatches.id),
  symbol: text("symbol").notNull().references(() => symbols.symbol, { onDelete: "cascade" }),
  price: numeric("price", { precision: 18, scale: 4 }).notNull(),
  previousClose: numeric("previous_close", { precision: 18, scale: 4 }),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
  marketState: text("market_state"),
  source: text("source").notNull().default("poll"),  // poll | bar_5m
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
}, (t) => [
  // The detector always reads one symbol over a time range.
  index("quote_obs_symbol_asof_idx").on(t.symbol, t.asOf),
  // Re-running the seed loader must not duplicate the price path.
  uniqueIndex("quote_obs_symbol_asof_source_idx").on(t.symbol, t.asOf, t.source),
]);

/**
 * Recomputed on schedule. This table is what turns a hardcoded threshold into an
 * actual judgement: a 4% move means nothing until it is measured against how
 * much this symbol usually moves.
 *
 * All levels are computed on the ADJUSTED series. On the raw series a split
 * would silently corrupt the 52-week high, which is precisely the trap the
 * corporate-actions work exists to avoid.
 */
export const symbolStats = pgTable("symbol_stats", {
  symbol: text("symbol").primaryKey().references(() => symbols.symbol, { onDelete: "cascade" }),
  batchId: integer("batch_id").notNull().references(() => ingestionBatches.id),
  realizedVol20: numeric("realized_vol_20", { precision: 18, scale: 10 }),
  medianVolume20: numeric("median_volume_20", { precision: 22, scale: 0 }),
  ma20: numeric("ma_20", { precision: 18, scale: 4 }),
  beta60: numeric("beta_60", { precision: 18, scale: 10 }),
  // Level-crossing signals. 52-week levels are specified by the brief; the 20-day
  // range is the shorter-horizon break. Hysteresis re-arming compares against
  // these stored levels, so they have to be persisted rather than recomputed.
  high52w: numeric("high_52w", { precision: 18, scale: 4 }),
  low52w: numeric("low_52w", { precision: 18, scale: 4 }),
  high20: numeric("high_20", { precision: 18, scale: 4 }),
  low20: numeric("low_20", { precision: 18, scale: 4 }),
  sessionsUsed: integer("sessions_used").notNull().default(0),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
});

/**
 * Corporate actions inferred from provider-history shifts, not from a feed.
 *
 * `fingerprint` is keyed on the identity of the event — symbol, type and the
 * affected span — deliberately NOT on the computed factor. Keying on the factor
 * would make a slightly different bar window produce a different fingerprint and
 * therefore a duplicate row for the same real-world split.
 */
export const corporateActions = pgTable("corporate_actions", {
  id: serial("id").primaryKey(),
  fingerprint: text("fingerprint").notNull(),
  symbol: text("symbol").notNull().references(() => symbols.symbol, { onDelete: "cascade" }),
  candidateType: text("candidate_type").notNull(),  // split
  factor: numeric("factor", { precision: 18, scale: 8 }),
  affectedFrom: date("affected_from", { mode: "string" }),
  affectedTo: date("affected_to", { mode: "string" }),
  supportingBars: integer("supporting_bars").notNull(),
  status: text("status").notNull(),                 // VALIDATED | REJECTED
  reason: text("reason").notNull(),
  batchId: integer("batch_id").notNull().references(() => ingestionBatches.id),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
}, (t) => [uniqueIndex("corporate_actions_fingerprint_idx").on(t.fingerprint)]);
