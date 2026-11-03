-- External storefront handoff (phase 1).
--
-- * business_units.marketing_origins: allowlist of the tenant's own marketing-site origins. A
--   checkout intent may only send the shopper back to one of them.
-- * orders.attribution: campaign tags (utm_*, ref) only; never identity or order data.
-- * checkout_intents: short-lived handoff naming a package and an allowlisted return link.

ALTER TABLE "business_units" ADD COLUMN "marketing_origins" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "attribution" jsonb;
--> statement-breakpoint

CREATE TABLE "checkout_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "package_id" uuid NOT NULL REFERENCES "packages"("id") ON DELETE cascade,
  "return_url" text,
  "attribution" jsonb,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "checkout_intents_bu_expires_idx" ON "checkout_intents" ("business_unit_id", "expires_at");
--> statement-breakpoint
CREATE INDEX "checkout_intents_package_idx" ON "checkout_intents" ("package_id");
--> statement-breakpoint

ALTER TABLE "checkout_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "checkout_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON checkout_intents
  USING (business_unit_id = app_current_business_unit() OR app_is_platform_scope())
  WITH CHECK (business_unit_id = app_current_business_unit() OR app_is_platform_scope());
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nio_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON checkout_intents TO nio_app;
  END IF;
END $$;
