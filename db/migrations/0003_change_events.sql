CREATE TABLE "change_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"signal_type" text NOT NULL,
	"window" text NOT NULL,
	"magnitude" numeric(18, 8) NOT NULL,
	"score" numeric(18, 8) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone NOT NULL,
	"ingestion_batch_id" integer NOT NULL,
	"supersedes_id" integer,
	"explain_json" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_symbol_symbols_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."symbols"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_ingestion_batch_id_ingestion_batches_id_fk" FOREIGN KEY ("ingestion_batch_id") REFERENCES "public"."ingestion_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_identity_idx" ON "change_events" USING btree ("symbol","signal_type","occurred_at");--> statement-breakpoint
CREATE INDEX "change_events_symbol_occurred_idx" ON "change_events" USING btree ("symbol","occurred_at");--> statement-breakpoint
CREATE INDEX "change_events_resolved_idx" ON "change_events" USING btree ("resolved_at");