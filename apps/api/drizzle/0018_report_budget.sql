-- Per-report AI allowance and API keys sent in a named header.
--
-- * platform_ai_settings.per_report_budget_usd: AI spend included with one order's report.
-- * report_messages.estimated_cost_usd: cost of the turn (on-topic check plus answer), recorded
--   on the assistant row so spend survives later price changes. Existing rows are priced from
--   their tokens at the provider's current rates.
-- * platform_llm_providers.auth_style / auth_header_name: send the key as
--   `Authorization: Bearer` (default) or in a named header such as x-goog-api-key.

ALTER TABLE "platform_ai_settings" ADD COLUMN "per_report_budget_usd" numeric(10, 2) DEFAULT '5.00' NOT NULL;
--> statement-breakpoint
ALTER TABLE "report_messages" ADD COLUMN "estimated_cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL;
--> statement-breakpoint
UPDATE "report_messages" m
SET "estimated_cost_usd" =
  (m."input_tokens"::numeric / 1000000) * p."input_token_cost_per_million"
  + (m."output_tokens"::numeric / 1000000) * p."output_token_cost_per_million"
FROM "platform_llm_providers" p
WHERE p."id" = m."provider_id" AND m."role" = 'assistant';
--> statement-breakpoint
CREATE TYPE "public"."llm_auth_style" AS ENUM('bearer', 'header');
--> statement-breakpoint
ALTER TABLE "platform_llm_providers" ADD COLUMN "auth_style" "llm_auth_style" DEFAULT 'bearer' NOT NULL;
--> statement-breakpoint
ALTER TABLE "platform_llm_providers" ADD COLUMN "auth_header_name" text;
