ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'pending';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'processing';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'partially_refunded';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'disputed';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'cancelled';
--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'expired';
--> statement-breakpoint
CREATE TYPE "payment_account_status" AS ENUM ('disconnected', 'pending', 'restricted', 'active');
--> statement-breakpoint
CREATE TYPE "catalog_sync_status" AS ENUM ('pending', 'syncing', 'synced', 'failed');
--> statement-breakpoint

CREATE TABLE "payment_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "provider" text DEFAULT 'stripe' NOT NULL,
  "provider_account_id" text,
  "status" "payment_account_status" DEFAULT 'disconnected' NOT NULL,
  "charges_enabled" boolean DEFAULT false NOT NULL,
  "payouts_enabled" boolean DEFAULT false NOT NULL,
  "details_submitted" boolean DEFAULT false NOT NULL,
  "country" text,
  "default_currency" text,
  "disabled_reason" text,
  "oauth_state_hash" text,
  "oauth_state_expires_at" timestamp with time zone,
  "disconnected_at" timestamp with time zone,
  "last_sync_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_bu_provider_key" ON "payment_accounts" ("business_unit_id", "provider");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_provider_account_key" ON "payment_accounts" ("provider", "provider_account_id");
--> statement-breakpoint

CREATE TABLE "package_payment_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "package_id" uuid NOT NULL REFERENCES "packages"("id") ON DELETE cascade,
  "provider" text DEFAULT 'stripe' NOT NULL,
  "provider_product_id" text,
  "provider_price_id" text,
  "status" "catalog_sync_status" DEFAULT 'pending' NOT NULL,
  "last_error" text,
  "synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "package_payment_mappings_package_provider_key" ON "package_payment_mappings" ("package_id", "provider");
--> statement-breakpoint
CREATE INDEX "package_payment_mappings_bu_status_idx" ON "package_payment_mappings" ("business_unit_id", "status");
--> statement-breakpoint

CREATE TABLE "catalog_sync_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "package_id" uuid NOT NULL REFERENCES "packages"("id") ON DELETE cascade,
  "provider" text DEFAULT 'stripe' NOT NULL,
  "status" "catalog_sync_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_sync_jobs_package_provider_key" ON "catalog_sync_jobs" ("package_id", "provider");
--> statement-breakpoint
CREATE INDEX "catalog_sync_jobs_bu_status_idx" ON "catalog_sync_jobs" ("business_unit_id", "status");
--> statement-breakpoint

CREATE TABLE "payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "order_id" uuid NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "provider_account_id" text,
  "checkout_session_id" text,
  "checkout_attempt" integer DEFAULT 1 NOT NULL,
  "payment_intent_id" text,
  "charge_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "amount_cents" integer NOT NULL,
  "currency" text DEFAULT 'usd' NOT NULL,
  "refunded_cents" integer DEFAULT 0 NOT NULL,
  "disputed_cents" integer DEFAULT 0 NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_provider_key" ON "payments" ("order_id", "provider");
--> statement-breakpoint
CREATE UNIQUE INDEX "payments_checkout_session_key" ON "payments" ("checkout_session_id");
--> statement-breakpoint
CREATE INDEX "payments_bu_status_idx" ON "payments" ("business_unit_id", "status");
--> statement-breakpoint

CREATE TABLE "payment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_unit_id" uuid NOT NULL REFERENCES "business_units"("id") ON DELETE cascade,
  "payment_id" uuid REFERENCES "payments"("id") ON DELETE set null,
  "provider" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "livemode" boolean DEFAULT false NOT NULL,
  "payload" jsonb NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_event_key" ON "payment_events" ("provider", "provider_event_id");
--> statement-breakpoint

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'payment_accounts', 'package_payment_mappings', 'catalog_sync_jobs', 'payments', 'payment_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;
--> statement-breakpoint

CREATE POLICY payment_admin_isolation ON payment_accounts
  USING (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')))
  WITH CHECK (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')));
--> statement-breakpoint
CREATE POLICY payment_admin_isolation ON package_payment_mappings
  USING (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')))
  WITH CHECK (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')));
--> statement-breakpoint
CREATE POLICY payment_admin_isolation ON catalog_sync_jobs
  USING (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')))
  WITH CHECK (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')));
--> statement-breakpoint
CREATE POLICY payment_actor_isolation ON payments
  USING (
    app_is_platform_scope() OR (
      business_unit_id = app_current_business_unit() AND (
        app_current_actor_role() IN ('system', 'bu_admin') OR
        (app_current_actor_role() = 'patient' AND EXISTS (
          SELECT 1 FROM orders o WHERE o.id = payments.order_id AND o.patient_user_id = app_current_user_id()
        ))
      )
    )
  )
  WITH CHECK (
    app_is_platform_scope() OR (
      business_unit_id = app_current_business_unit() AND (
        app_current_actor_role() IN ('system', 'bu_admin') OR
        (app_current_actor_role() = 'patient' AND EXISTS (
          SELECT 1 FROM orders o WHERE o.id = payments.order_id AND o.patient_user_id = app_current_user_id()
        ))
      )
    )
  );
--> statement-breakpoint
CREATE POLICY payment_actor_isolation ON payment_events
  USING (
    app_is_platform_scope() OR (
      business_unit_id = app_current_business_unit() AND (
        app_current_actor_role() IN ('system', 'bu_admin') OR
        (app_current_actor_role() = 'patient' AND EXISTS (
          SELECT 1 FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.id = payment_events.payment_id AND o.patient_user_id = app_current_user_id()
        ))
      )
    )
  )
  WITH CHECK (app_is_platform_scope() OR (business_unit_id = app_current_business_unit() AND app_current_actor_role() IN ('system', 'bu_admin')));
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nio_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment_accounts, package_payment_mappings, catalog_sync_jobs, payments, payment_events TO nio_app;
  END IF;
END $$;
