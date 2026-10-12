CREATE TYPE "public"."file_extraction_method" AS ENUM('pdf_text', 'ocr');
--> statement-breakpoint
CREATE TYPE "public"."report_message_role" AS ENUM('user', 'assistant');
--> statement-breakpoint
CREATE TABLE "file_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"extracted_text" text NOT NULL,
	"method" "file_extraction_method" NOT NULL,
	"page_count" integer DEFAULT 1 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "file_extractions_file_key" ON "file_extractions" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX "file_extractions_bu_idx" ON "file_extractions" USING btree ("business_unit_id");
--> statement-breakpoint
ALTER TABLE "file_extractions" ADD CONSTRAINT "file_extractions_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "file_extractions" ADD CONSTRAINT "file_extractions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "platform_ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rails_prompt" text DEFAULT '' NOT NULL,
	"disclaimer" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"api_url" text NOT NULL,
	"api_key_ciphertext" text DEFAULT '' NOT NULL,
	"model" text NOT NULL,
	"custom_headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_token_cost_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"output_token_cost_per_million" numeric(12, 6) DEFAULT '0' NOT NULL,
	"max_output_tokens" integer DEFAULT 1024 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_llm_providers_sort_idx" ON "platform_llm_providers" USING btree ("sort_order");
--> statement-breakpoint
CREATE TABLE "business_unit_ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"rails_prompt" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "business_unit_ai_settings_bu_key" ON "business_unit_ai_settings" USING btree ("business_unit_id");
--> statement-breakpoint
ALTER TABLE "business_unit_ai_settings" ADD CONSTRAINT "business_unit_ai_settings_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "report_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"patient_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "report_conversations_order_key" ON "report_conversations" USING btree ("order_id");
--> statement-breakpoint
CREATE INDEX "report_conversations_patient_idx" ON "report_conversations" USING btree ("patient_user_id");
--> statement-breakpoint
ALTER TABLE "report_conversations" ADD CONSTRAINT "report_conversations_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_conversations" ADD CONSTRAINT "report_conversations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_conversations" ADD CONSTRAINT "report_conversations_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "report_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "report_message_role" NOT NULL,
	"content" text NOT NULL,
	"provider_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "report_messages_conversation_idx" ON "report_messages" USING btree ("conversation_id","created_at");
--> statement-breakpoint
ALTER TABLE "report_messages" ADD CONSTRAINT "report_messages_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_messages" ADD CONSTRAINT "report_messages_conversation_id_report_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."report_conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_messages" ADD CONSTRAINT "report_messages_provider_id_platform_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_llm_providers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "patient_llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"patient_user_id" uuid NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_llm_usage_patient_key" ON "patient_llm_usage" USING btree ("business_unit_id","patient_user_id");
--> statement-breakpoint
ALTER TABLE "patient_llm_usage" ADD CONSTRAINT "patient_llm_usage_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_llm_usage" ADD CONSTRAINT "patient_llm_usage_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "file_extractions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "file_extractions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON file_extractions
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
            FROM files f
            JOIN lab_results lr ON lr.file_id = f.id
            JOIN orders o ON o.id = lr.order_id
            WHERE f.id = file_extractions.file_id
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
      AND (
        app_current_actor_role() IN ('system', 'bu_admin', 'lab', 'doctor')
        OR (
          app_current_actor_role() = 'patient'
          AND EXISTS (
            SELECT 1
            FROM files f
            JOIN lab_results lr ON lr.file_id = f.id
            JOIN orders o ON o.id = lr.order_id
            WHERE f.id = file_extractions.file_id
              AND o.patient_user_id = app_current_user_id()
              AND o.status = 'results_released'
          )
        )
      )
    )
  );
--> statement-breakpoint

ALTER TABLE "business_unit_ai_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "business_unit_ai_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON business_unit_ai_settings
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND app_current_actor_role() IN ('system', 'bu_admin')
    )
  )
  WITH CHECK (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND app_current_actor_role() IN ('system', 'bu_admin')
    )
  );
--> statement-breakpoint

ALTER TABLE "report_conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "report_conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON report_conversations
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin')
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
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'patient'
          AND patient_user_id = app_current_user_id()
        )
      )
    )
  );
--> statement-breakpoint

ALTER TABLE "report_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "report_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON report_messages
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'patient'
          AND EXISTS (
            SELECT 1 FROM report_conversations c
            WHERE c.id = report_messages.conversation_id
              AND c.patient_user_id = app_current_user_id()
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
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'patient'
          AND EXISTS (
            SELECT 1 FROM report_conversations c
            WHERE c.id = report_messages.conversation_id
              AND c.patient_user_id = app_current_user_id()
          )
        )
      )
    )
  );
--> statement-breakpoint

ALTER TABLE "patient_llm_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "patient_llm_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_actor_isolation ON patient_llm_usage
  USING (
    app_is_platform_scope()
    OR (
      business_unit_id = app_current_business_unit()
      AND (
        app_current_actor_role() IN ('system', 'bu_admin')
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
        app_current_actor_role() IN ('system', 'bu_admin')
        OR (
          app_current_actor_role() = 'patient'
          AND patient_user_id = app_current_user_id()
        )
      )
    )
  );
