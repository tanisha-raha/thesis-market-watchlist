-- Thesis-aware notifications, and the preferences that gate them.
--
-- Additive and standalone: nothing existing references either table, so every
-- current user, watchlist, thesis, event and evidence row is untouched, and
-- dropping both would leave the deterministic product intact.
--
-- IDEMPOTENCY IS THE UNIQUE INDEX. A notification is tied to the committed row
-- it was derived from — a thesis verdict or a change event — so re-running
-- generation over the same evidence cannot produce a second copy. There is no
-- other de-duplication logic anywhere; the database is the guarantee.
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "symbol" text NOT NULL REFERENCES "symbols"("symbol") ON DELETE CASCADE,
  "type" text NOT NULL,
  -- Delivery channel. IN_APP today; the column is what lets another one be
  -- added without rewriting how notifications are generated or stored.
  "channel" text NOT NULL DEFAULT 'IN_APP',
  -- LIVE and DEMO REPLAY never mix, here as everywhere else.
  "data_mode" text NOT NULL DEFAULT 'live',
  -- The thesis health at the moment this was generated, when the notification
  -- is about a thesis at all. Null for a market event with no condition behind it.
  "health" text,
  -- One sentence, composed from the stored evidence. Never model output.
  "reason" text NOT NULL,
  "link" text NOT NULL,
  -- The committed row this came from. Together with type and user, the identity.
  "source_kind" text NOT NULL,
  "source_id" integer NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "read_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "notifications_identity_idx"
  ON "notifications" ("user_id", "type", "source_kind", "source_id");
CREATE INDEX IF NOT EXISTS "notifications_user_idx"
  ON "notifications" ("user_id", "occurred_at" DESC);

-- One row per user, created on first read. Defaults are every thesis-relevant
-- signal on and nothing else: this product does not do generic price alerts.
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "user_id" integer PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "in_app" boolean NOT NULL DEFAULT true,
  "on_trigger" boolean NOT NULL DEFAULT true,
  "on_needs_attention" boolean NOT NULL DEFAULT true,
  "on_weakened" boolean NOT NULL DEFAULT true,
  "on_invalidated" boolean NOT NULL DEFAULT true,
  "on_reversal" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
