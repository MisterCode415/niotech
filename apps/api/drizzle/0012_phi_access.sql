-- PHI access audit (HIPAA step 1) and the per-provider "approved for PHI" flag.
--
-- phi_access_events deliberately has no foreign keys: an audit trail must outlive the rows it
-- describes, and a cascading delete must never be able to erase it.

CREATE TYPE "public"."phi_resource_type" AS ENUM('order_detail', 'result_file', 'result_text', 'conversation', 'review');
--> statement-breakpoint
CREATE TYPE "public"."phi_access_action" AS ENUM('view', 'download', 'extract', 'chat');
--> statement-breakpoint
CREATE TABLE "phi_access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_role" text NOT NULL,
	"acting_platform_admin" boolean DEFAULT false NOT NULL,
	"resource_type" "phi_resource_type" NOT NULL,
	"resource_id" uuid,
	"order_id" uuid,
	"action" "phi_access_action" NOT NULL,
	"request_id" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "phi_access_events_bu_order_idx" ON "phi_access_events" USING btree ("business_unit_id","order_id","created_at");
--> statement-breakpoint
CREATE INDEX "phi_access_events_actor_idx" ON "phi_access_events" USING btree ("business_unit_id","actor_user_id","created_at");
--> statement-breakpoint

ALTER TABLE "phi_access_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "phi_access_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Any actor may append a row, but only for their own business unit and only as themselves.
CREATE POLICY phi_access_insert ON phi_access_events
  FOR INSERT
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() = 'system'
        OR actor_user_id = app_current_user_id()
      )
    )
  );
--> statement-breakpoint
-- Reading the trail is limited to the business unit admin and the platform.
CREATE POLICY phi_access_select ON phi_access_events
  FOR SELECT
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND app_current_actor_role() = 'bu_admin'
    )
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION phi_access_events_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'phi_access_events is append-only';
  END
  $$;
--> statement-breakpoint
CREATE TRIGGER phi_access_events_append_only
  BEFORE UPDATE OR DELETE ON phi_access_events
  FOR EACH ROW EXECUTE FUNCTION phi_access_events_immutable();
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nio_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON phi_access_events FROM nio_app;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "platform_llm_providers" ADD COLUMN "phi_approved" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_llm_providers" ADD COLUMN "phi_approved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "platform_llm_providers" ADD COLUMN "phi_approval_note" text;
