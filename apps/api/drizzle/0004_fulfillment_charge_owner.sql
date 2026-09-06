ALTER TABLE fulfillment_charges
  ADD COLUMN fulfillment_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint

UPDATE fulfillment_charges charge
SET fulfillment_user_id = account.user_id
FROM fulfillment_accounts account
WHERE charge.fulfillment_account_id = account.id
  AND charge.fulfillment_user_id IS NULL;
--> statement-breakpoint

-- Older charges could be created before an account was configured. Attribute those to the latest
-- fulfillment actor recorded on their order when possible.
UPDATE fulfillment_charges charge
SET fulfillment_user_id = (
  SELECT event.actor_user_id
  FROM order_events event
  WHERE event.order_id = charge.order_id
    AND event.actor_role = 'fulfillment'
    AND event.actor_user_id IS NOT NULL
  ORDER BY event.created_at DESC
  LIMIT 1
)
WHERE charge.fulfillment_user_id IS NULL;
--> statement-breakpoint

CREATE INDEX fulfillment_charges_user_idx
  ON fulfillment_charges (business_unit_id, fulfillment_user_id);
--> statement-breakpoint

DROP POLICY IF EXISTS tenant_actor_isolation ON fulfillment_charges;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON fulfillment_charges
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'fulfillment'
          AND fulfillment_user_id = app_current_user_id()
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
          AND fulfillment_user_id = app_current_user_id()
        )
      )
    )
  );
