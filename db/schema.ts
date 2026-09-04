import {
  pgTable, text, timestamp, integer, numeric, uniqueIndex, index, serial,
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
