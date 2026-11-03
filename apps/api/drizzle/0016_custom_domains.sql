-- Per-tenant custom domains and white-label branding (phase 3).
--
-- * business_unit_domains: hostnames a tenant serves its storefront and portal from. Only a
--   verified row resolves to a tenant or is approved for a certificate.
-- * business_units.brand: logo, display name, and primary color for the tenant's pages.

CREATE TYPE "public"."domain_status" AS ENUM('pending', 'verified', 'disabled');
--> statement-breakpoint

ALTER TABLE "business_units" ADD COLUMN "brand" jsonb;
--> statement-breakpoint

CREATE TABLE "business_unit_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "hostname" text NOT NULL,
  "status" "domain_status" DEFAULT 'pending' NOT NULL,
  "verification_token" text NOT NULL,
  "verified_at" timestamp with time zone,
  "is_primary" boolean DEFAULT false NOT NULL,
  "last_check_at" timestamp with time zone,
  "last_check_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "business_unit_domains_hostname_lower" CHECK ("hostname" = lower("hostname")),
  CONSTRAINT "business_unit_domains_primary_verified" CHECK (NOT "is_primary" OR "status" = 'verified')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_unit_domains_hostname_key" ON "business_unit_domains" ("hostname");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_unit_domains_one_primary_key" ON "business_unit_domains" ("business_unit_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "business_unit_domains_bu_idx" ON "business_unit_domains" ("business_unit_id");
--> statement-breakpoint

ALTER TABLE "business_unit_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_unit_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A tenant may read its own domains (to see which DNS records to publish); only the platform
-- may create, verify, or change them.
CREATE POLICY domain_read ON business_unit_domains
  FOR SELECT
  USING (business_unit_id = app_current_business_unit() OR app_is_platform_scope());
--> statement-breakpoint
CREATE POLICY domain_write ON business_unit_domains
  FOR ALL
  USING (app_is_platform_scope())
  WITH CHECK (app_is_platform_scope());
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nio_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON business_unit_domains TO nio_app;
  END IF;
END $$;
