ALTER TABLE "order_events" ADD COLUMN "event_sequence" bigserial NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "order_events_order_idx";
--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" ("order_id", "event_sequence");
