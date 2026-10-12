-- Reading or exporting the audit trail is itself a disclosure worth recording, so the access
-- trail gains a resource type and an action for it. The new values are not used in this migration.
ALTER TYPE "public"."phi_resource_type" ADD VALUE IF NOT EXISTS 'disclosure_export';
--> statement-breakpoint
ALTER TYPE "public"."phi_access_action" ADD VALUE IF NOT EXISTS 'export';
