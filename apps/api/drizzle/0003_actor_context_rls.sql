-- Add the authenticated user and role to PostgreSQL's transaction-local authorization context.
-- Tenant isolation remains the outer boundary; these policies add patient ownership and prevent
-- workflow roles from reading result/billing data their job does not require.

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.user_id', true), '')::uuid
  $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_current_actor_role() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('app.actor_role', true), '')
  $$;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON orders;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON orders
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin', 'fulfillment', 'lab', 'doctor')
        OR (
          app_current_actor_role() = 'patient'
          AND patient_user_id = app_current_user_id()
        )
      )
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin', 'fulfillment', 'lab', 'doctor')
        OR (
          app_current_actor_role() = 'patient'
          AND patient_user_id = app_current_user_id()
        )
      )
    )
  );
--> statement-breakpoint

-- Operational order children follow ownership of their parent order for patients. All workflow
-- roles need these rows to move kits through fulfillment and lab processing.
DO $$
DECLARE
  target text;
  operational_tables text[] := ARRAY[
    'kits',
    'shipments',
    'order_events',
    'order_issues'
  ];
BEGIN
  FOREACH target IN ARRAY operational_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_actor_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_actor_isolation ON %I
         USING (
           app_is_platform_scope()
           OR (
             business_unit_id = app_current_business_unit()
             AND (
               app_current_actor_role() IN (''system'', ''bu_admin'', ''fulfillment'', ''lab'', ''doctor'')
               OR (
                 app_current_actor_role() = ''patient''
                 AND EXISTS (
                   SELECT 1 FROM orders o
                   WHERE o.id = %I.order_id
                     AND o.patient_user_id = app_current_user_id()
                 )
               )
             )
           )
         )
         WITH CHECK (
           app_is_platform_scope()
           OR (
             business_unit_id = app_current_business_unit()
             AND (
               app_current_actor_role() IN (''system'', ''bu_admin'', ''fulfillment'', ''lab'', ''doctor'')
               OR (
                 app_current_actor_role() = ''patient''
                 AND EXISTS (
                   SELECT 1 FROM orders o
                   WHERE o.id = %I.order_id
                     AND o.patient_user_id = app_current_user_id()
                 )
               )
             )
           )
         )',
      target,
      target,
      target
    );
  END LOOP;
END
$$;
--> statement-breakpoint

-- Clinical results are unavailable to fulfillment and only become database-visible to the owning
-- patient after release. API checks remain in place as a second boundary.
DO $$
DECLARE
  target text;
  clinical_tables text[] := ARRAY['lab_results', 'clinician_reviews'];
BEGIN
  FOREACH target IN ARRAY clinical_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_actor_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_actor_isolation ON %I
         USING (
           app_is_platform_scope()
           OR (
             business_unit_id = app_current_business_unit()
             AND (
               app_current_actor_role() IN (''system'', ''bu_admin'', ''lab'', ''doctor'')
               OR (
                 app_current_actor_role() = ''patient''
                 AND EXISTS (
                   SELECT 1 FROM orders o
                   WHERE o.id = %I.order_id
                     AND o.patient_user_id = app_current_user_id()
                     AND o.status = ''results_released''
                 )
               )
             )
           )
         )
         WITH CHECK (
           app_is_platform_scope()
           OR (
             business_unit_id = app_current_business_unit()
             AND app_current_actor_role() IN (''system'', ''bu_admin'', ''lab'', ''doctor'')
           )
         )',
      target,
      target
    );
  END LOOP;
END
$$;
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON files;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON files
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin', 'lab', 'doctor')
        OR (
          app_current_actor_role() = 'patient'
          AND EXISTS (
            SELECT 1
            FROM lab_results lr
            JOIN orders o ON o.id = lr.order_id
            WHERE lr.file_id = files.id
              AND o.patient_user_id = app_current_user_id()
              AND o.status = 'results_released'
          )
        )
      )
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND app_current_actor_role() IN ('system', 'bu_admin', 'lab')
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON notifications;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON notifications
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() = 'system'
        OR user_id = app_current_user_id()
      )
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() = 'system'
        OR user_id = app_current_user_id()
      )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON fulfillment_accounts;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON fulfillment_accounts
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'fulfillment'
          AND user_id = app_current_user_id()
        )
      )
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'fulfillment'
          AND user_id = app_current_user_id()
        )
      )
    )
  );
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_isolation ON fulfillment_charges;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON fulfillment_charges
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND app_current_actor_role() IN ('system', 'bu_admin', 'fulfillment')
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND app_current_actor_role() IN ('system', 'bu_admin', 'fulfillment')
    )
  );
