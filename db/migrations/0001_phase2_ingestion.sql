CREATE TABLE "ingestion_batches" ("id" serial PRIMARY KEY NOT NULL,"status" text NOT NULL,"started_at" timestamp with time zone DEFAULT now() NOT NULL,"completed_at" timestamp with time zone,"requested_count" integer DEFAULT 0 NOT NULL,"success_count" integer DEFAULT 0 NOT NULL,"missing_count" integer DEFAULT 0 NOT NULL,"failure_count" integer DEFAULT 0 NOT NULL,"failure_summary" text);
--> statement-breakpoint
CREATE TABLE "price_bars" ("symbol" text NOT NULL,"trading_date" date NOT NULL,"first_observed_close" numeric(18,4),"first_observed_volume" numeric(22,0),"first_observed_at" timestamp with time zone NOT NULL,"first_observed_batch_id" integer NOT NULL,"current_provider_close" numeric(18,4),"current_provider_adj_close" numeric(18,4),"current_provider_volume" numeric(22,0),"refreshed_at" timestamp with time zone NOT NULL,"refreshed_batch_id" integer NOT NULL);
--> statement-breakpoint
CREATE TABLE "quote_observations" ("id" serial PRIMARY KEY NOT NULL,"batch_id" integer NOT NULL,"symbol" text NOT NULL,"price" numeric(18,4) NOT NULL,"previous_close" numeric(18,4),"as_of" timestamp with time zone NOT NULL,"market_state" text,"fetched_at" timestamp with time zone NOT NULL);
--> statement-breakpoint
CREATE TABLE "symbol_stats" ("symbol" text PRIMARY KEY NOT NULL,"batch_id" integer NOT NULL,"realized_vol_20" numeric(18,10),"median_volume_20" numeric(22,0),"ma_20" numeric(18,4),"beta_60" numeric(18,10),"computed_at" timestamp with time zone NOT NULL);
--> statement-breakpoint
CREATE TABLE "corporate_actions" ("id" serial PRIMARY KEY NOT NULL,"fingerprint" text NOT NULL,"symbol" text NOT NULL,"candidate_type" text NOT NULL,"factor" numeric(18,8),"affected_from" date,"affected_to" date,"supporting_bars" integer NOT NULL,"status" text NOT NULL,"reason" text NOT NULL,"batch_id" integer NOT NULL,"detected_at" timestamp with time zone NOT NULL);
--> statement-breakpoint
ALTER TABLE "price_bars" ADD CONSTRAINT "pb_sym" FOREIGN KEY ("symbol") REFERENCES "symbols"("symbol") ON DELETE cascade;
ALTER TABLE "price_bars" ADD CONSTRAINT "pb_first" FOREIGN KEY ("first_observed_batch_id") REFERENCES "ingestion_batches"("id");
ALTER TABLE "price_bars" ADD CONSTRAINT "pb_refresh" FOREIGN KEY ("refreshed_batch_id") REFERENCES "ingestion_batches"("id");
ALTER TABLE "quote_observations" ADD CONSTRAINT "qo_batch" FOREIGN KEY ("batch_id") REFERENCES "ingestion_batches"("id");
ALTER TABLE "quote_observations" ADD CONSTRAINT "qo_sym" FOREIGN KEY ("symbol") REFERENCES "symbols"("symbol") ON DELETE cascade;
ALTER TABLE "symbol_stats" ADD CONSTRAINT "ss_batch" FOREIGN KEY ("batch_id") REFERENCES "ingestion_batches"("id");
ALTER TABLE "symbol_stats" ADD CONSTRAINT "ss_sym" FOREIGN KEY ("symbol") REFERENCES "symbols"("symbol") ON DELETE cascade;
ALTER TABLE "corporate_actions" ADD CONSTRAINT "ca_sym" FOREIGN KEY ("symbol") REFERENCES "symbols"("symbol") ON DELETE cascade;
ALTER TABLE "corporate_actions" ADD CONSTRAINT "ca_batch" FOREIGN KEY ("batch_id") REFERENCES "ingestion_batches"("id");
CREATE UNIQUE INDEX "price_bars_symbol_date_idx" ON "price_bars" ("symbol","trading_date");
CREATE UNIQUE INDEX "corporate_actions_fingerprint_idx" ON "corporate_actions" ("fingerprint");
