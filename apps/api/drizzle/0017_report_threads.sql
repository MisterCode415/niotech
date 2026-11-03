-- Report chat threads.
--
-- * A patient can hold several conversations about one order, so the one-per-order index goes.
-- * title: application-encrypted (enc:v1:...), taken from the thread's first question.
-- * archived_at: patients hide a thread; the row stays for retention and the audit trail.
-- The tenant_actor_isolation policies from 0011 key on patient and tenant, so they still apply.

DROP INDEX IF EXISTS "report_conversations_order_key";
--> statement-breakpoint
CREATE INDEX "report_conversations_order_idx" ON "report_conversations" USING btree ("order_id","updated_at");
--> statement-breakpoint
ALTER TABLE "report_conversations" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "report_conversations" ADD COLUMN "archived_at" timestamp with time zone;
