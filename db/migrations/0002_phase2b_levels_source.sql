-- Phase 2b — idempotent by construction.
--
-- This migration has to succeed against two different database states, because
-- migration 0001 was hand-written and then edited AFTER it had already been
-- applied. Drizzle records migrations by hash and never re-runs one it has seen,
-- so databases that ran the pre-edit 0001 are missing `corporate_actions` while
-- a fresh database has everything. `db:migrate` reported success on both and the
-- divergence was silent.
--
-- Hence IF NOT EXISTS throughout, and foreign keys guarded on (table, column)
-- rather than on constraint name: 0001 created the same relationships under
-- different names (pb_sym, qo_batch, ...), and matching on name alone would add
-- a second, duplicate foreign key on databases that already have one.
--
-- The lesson is recorded in DECISIONS.md: never edit an applied migration.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingestion_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"requested_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"missing_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"failure_summary" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "price_bars" (
	"symbol" text NOT NULL,
	"trading_date" date NOT NULL,
	"first_observed_close" numeric(18, 4),
	"first_observed_volume" numeric(22, 0),
	"first_observed_at" timestamp with time zone NOT NULL,
	"first_observed_batch_id" integer NOT NULL,
	"current_provider_close" numeric(18, 4),
	"current_provider_adj_close" numeric(18, 4),
	"current_provider_volume" numeric(22, 0),
	"refreshed_at" timestamp with time zone NOT NULL,
	"refreshed_batch_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"previous_close" numeric(18, 4),
	"as_of" timestamp with time zone NOT NULL,
	"market_state" text,
	"source" text DEFAULT 'poll' NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "symbol_stats" (
	"symbol" text PRIMARY KEY NOT NULL,
	"batch_id" integer NOT NULL,
	"realized_vol_20" numeric(18, 10),
	"median_volume_20" numeric(22, 0),
	"ma_20" numeric(18, 4),
	"beta_60" numeric(18, 10),
	"high_52w" numeric(18, 4),
	"low_52w" numeric(18, 4),
	"high_20" numeric(18, 4),
	"low_20" numeric(18, 4),
	"sessions_used" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- The table migration 0001 silently failed to create on already-migrated databases.
CREATE TABLE IF NOT EXISTS "corporate_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"symbol" text NOT NULL,
	"candidate_type" text NOT NULL,
	"factor" numeric(18, 8),
	"affected_from" date,
	"affected_to" date,
	"supporting_bars" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"batch_id" integer NOT NULL,
	"detected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Columns added in this migration, for databases that already have the tables.
ALTER TABLE "quote_observations" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'poll' NOT NULL;
--> statement-breakpoint
ALTER TABLE "symbol_stats" ADD COLUMN IF NOT EXISTS "high_52w" numeric(18, 4);
ALTER TABLE "symbol_stats" ADD COLUMN IF NOT EXISTS "low_52w" numeric(18, 4);
ALTER TABLE "symbol_stats" ADD COLUMN IF NOT EXISTS "high_20" numeric(18, 4);
ALTER TABLE "symbol_stats" ADD COLUMN IF NOT EXISTS "low_20" numeric(18, 4);
ALTER TABLE "symbol_stats" ADD COLUMN IF NOT EXISTS "sessions_used" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.corporate_actions'::regclass AND c.contype = 'f' AND a.attname = 'symbol'
  ) THEN
    ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_symbol_symbols_symbol_fk"
      FOREIGN KEY ("symbol") REFERENCES "public"."symbols"("symbol") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.corporate_actions'::regclass AND c.contype = 'f' AND a.attname = 'batch_id'
  ) THEN
    ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_batch_id_ingestion_batches_id_fk"
      FOREIGN KEY ("batch_id") REFERENCES "public"."ingestion_batches"("id");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.price_bars'::regclass AND c.contype = 'f' AND a.attname = 'symbol'
  ) THEN
    ALTER TABLE "price_bars" ADD CONSTRAINT "price_bars_symbol_symbols_symbol_fk"
      FOREIGN KEY ("symbol") REFERENCES "public"."symbols"("symbol") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.price_bars'::regclass AND c.contype = 'f' AND a.attname = 'first_observed_batch_id'
  ) THEN
    ALTER TABLE "price_bars" ADD CONSTRAINT "price_bars_first_observed_batch_id_ingestion_batches_id_fk"
      FOREIGN KEY ("first_observed_batch_id") REFERENCES "public"."ingestion_batches"("id");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.price_bars'::regclass AND c.contype = 'f' AND a.attname = 'refreshed_batch_id'
  ) THEN
    ALTER TABLE "price_bars" ADD CONSTRAINT "price_bars_refreshed_batch_id_ingestion_batches_id_fk"
      FOREIGN KEY ("refreshed_batch_id") REFERENCES "public"."ingestion_batches"("id");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.quote_observations'::regclass AND c.contype = 'f' AND a.attname = 'batch_id'
  ) THEN
    ALTER TABLE "quote_observations" ADD CONSTRAINT "quote_observations_batch_id_ingestion_batches_id_fk"
      FOREIGN KEY ("batch_id") REFERENCES "public"."ingestion_batches"("id");
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.quote_observations'::regclass AND c.contype = 'f' AND a.attname = 'symbol'
  ) THEN
    ALTER TABLE "quote_observations" ADD CONSTRAINT "quote_observations_symbol_symbols_symbol_fk"
      FOREIGN KEY ("symbol") REFERENCES "public"."symbols"("symbol") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.symbol_stats'::regclass AND c.contype = 'f' AND a.attname = 'symbol'
  ) THEN
    ALTER TABLE "symbol_stats" ADD CONSTRAINT "symbol_stats_symbol_symbols_symbol_fk"
      FOREIGN KEY ("symbol") REFERENCES "public"."symbols"("symbol") ON DELETE cascade;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.symbol_stats'::regclass AND c.contype = 'f' AND a.attname = 'batch_id'
  ) THEN
    ALTER TABLE "symbol_stats" ADD CONSTRAINT "symbol_stats_batch_id_ingestion_batches_id_fk"
      FOREIGN KEY ("batch_id") REFERENCES "public"."ingestion_batches"("id");
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "corporate_actions_fingerprint_idx" ON "corporate_actions" USING btree ("fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_bars_symbol_date_idx" ON "price_bars" USING btree ("symbol","trading_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_obs_symbol_asof_idx" ON "quote_observations" USING btree ("symbol","as_of");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "quote_obs_symbol_asof_source_idx" ON "quote_observations" USING btree ("symbol","as_of","source");
