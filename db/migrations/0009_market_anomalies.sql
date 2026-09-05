-- Stored anomaly evaluations from the optional ML layer.
--
-- Additive and standalone: nothing existing references it, so every current
-- user, watchlist, thesis, event and evidence row is untouched, and dropping
-- this table would leave the deterministic product intact.
--
-- Append-only, on the same discipline as change_events: a row records what the
-- model saw at detection time and is never rewritten. The unique index is the
-- idempotency key — re-running detection over the same session, model version
-- and data mode cannot produce a second opinion about the same day.
CREATE TABLE IF NOT EXISTS "market_anomalies" (
  "id" serial PRIMARY KEY,
  "symbol" text NOT NULL REFERENCES "symbols"("symbol") ON DELETE CASCADE,
  "trading_date" date NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "score" numeric(18, 10),
  "threshold" numeric(18, 10),
  "model_version" text NOT NULL,
  "data_mode" text NOT NULL,
  "features_json" jsonb NOT NULL,
  "window_json" jsonb NOT NULL,
  "evaluated_at" timestamp with time zone NOT NULL,
  "batch_id" integer NOT NULL REFERENCES "ingestion_batches"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "market_anomalies_identity_idx"
  ON "market_anomalies" ("symbol", "trading_date", "model_version", "data_mode");
CREATE INDEX IF NOT EXISTS "market_anomalies_symbol_date_idx"
  ON "market_anomalies" ("symbol", "trading_date" DESC);
