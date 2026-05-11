CREATE TABLE IF NOT EXISTS "triage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"token_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"channel_id" text NOT NULL,
	"channel_kind" text NOT NULL,
	"sender_external_user_id_hash" text NOT NULL,
	"body_length" integer NOT NULL,
	"vena_ids_matched" text[],
	"classification_outcome" text NOT NULL,
	"confidence" numeric(3, 2),
	"route_kind" text NOT NULL,
	"route_target_id" text,
	"triage_issue_id" text,
	"cached_response_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_events_correlation_id_idx" ON "triage_events" USING btree ("correlation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "triage_events_idempotency_uq" ON "triage_events" USING btree ("idempotency_key_hash","payload_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_events_created_at_idx" ON "triage_events" USING btree ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "triage_events_outcome_created_at_idx" ON "triage_events" USING btree ("classification_outcome","created_at" DESC);
