CREATE TABLE "theses" (
	"id" serial PRIMARY KEY NOT NULL,
	"watchlist_item_id" integer NOT NULL,
	"type" text NOT NULL,
	"params_json" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'WATCHING' NOT NULL,
	"last_acknowledged_at" timestamp with time zone,
	"params_adjusted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "thesis_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"thesis_id" integer NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"conditions_met_json" jsonb NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_symbol_read_state" (
	"user_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_seen_price_adj" numeric(18, 4),
	"last_seen_event_id" integer,
	"price_adjusted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "theses" ADD CONSTRAINT "theses_watchlist_item_id_watchlist_items_id_fk" FOREIGN KEY ("watchlist_item_id") REFERENCES "public"."watchlist_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thesis_events" ADD CONSTRAINT "thesis_events_thesis_id_theses_id_fk" FOREIGN KEY ("thesis_id") REFERENCES "public"."theses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_symbol_read_state" ADD CONSTRAINT "user_symbol_read_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_symbol_read_state" ADD CONSTRAINT "user_symbol_read_state_symbol_symbols_symbol_fk" FOREIGN KEY ("symbol") REFERENCES "public"."symbols"("symbol") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "theses_watchlist_item_idx" ON "theses" USING btree ("watchlist_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thesis_events_identity_idx" ON "thesis_events" USING btree ("thesis_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "thesis_events_thesis_idx" ON "thesis_events" USING btree ("thesis_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "read_state_user_symbol_idx" ON "user_symbol_read_state" USING btree ("user_id","symbol");