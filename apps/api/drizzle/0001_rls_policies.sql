-- Tenant isolation, enforced by the database rather than only by application code.
--
-- Every tenant-owned table carries `business_unit_id`. The API opens a transaction, declares
-- which tenant it is acting for via `set_config('app.business_unit_id', ..., true)`, and Postgres
-- filters everything from there. Code paths that legitimately span tenants (migrations, seeding,
-- platform-superadmin endpoints) instead set `app.tenant_scope` to 'platform'.
--
-- FORCE is required: the application connects as the table owner, and owners bypass RLS otherwise.

CREATE OR REPLACE FUNCTION app_current_business_unit() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.business_unit_id', true), '')::uuid
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_is_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('app.tenant_scope', true), '') = 'platform'
  $$;
--> statement-breakpoint

DO $$
DECLARE
  target text;
  tenant_tables text[] := ARRAY[
    'memberships',
    'marketing_pages',
    'test_types',
    'packages',
    'orders',
    'kits',
    'shipments',
    'order_events',
    'order_issues',
    'files',
    'lab_results',
    'clinician_reviews',
    'notifications',
    'fulfillment_accounts',
    'fulfillment_charges'
  ];
BEGIN
  FOREACH target IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (business_unit_id = app_current_business_unit() OR app_is_platform_scope())
         WITH CHECK (business_unit_id = app_current_business_unit() OR app_is_platform_scope())',
      target
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- `package_test_types` has no tenant column of its own; it is only reachable through a package
-- row that is already filtered, so it inherits isolation from its parent.
ALTER TABLE package_test_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE package_test_types FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON package_test_types;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON package_test_types
  USING (
    app_is_platform_scope()
    OR EXISTS (
      SELECT 1 FROM packages p
      WHERE p.id = package_test_types.package_id
        AND p.business_unit_id = app_current_business_unit()
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR EXISTS (
      SELECT 1 FROM packages p
      WHERE p.id = package_test_types.package_id
        AND p.business_unit_id = app_current_business_unit()
    )
  );
