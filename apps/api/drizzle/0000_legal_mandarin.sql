CREATE TYPE "public"."actor_role" AS ENUM('bu_admin', 'patient', 'fulfillment', 'lab', 'doctor', 'platform_admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."business_unit_status" AS ENUM('active', 'suspended', 'removed');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('pending', 'batched', 'paid');--> statement-breakpoint
CREATE TYPE "public"."clinician_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."kit_status" AS ENUM('awaiting_fulfillment', 'labeled', 'shipped', 'received_by_patient', 'sample_in_transit', 'received_by_lab', 'processing', 'lab_complete', 'problem');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('bu_admin', 'patient', 'fulfillment', 'lab', 'doctor');--> statement-breakpoint
CREATE TYPE "public"."order_issue_reason" AS ENUM('address_invalid', 'out_of_stock', 'damaged_kit', 'payment_query', 'other');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'paid', 'dispatched_to_fulfillment', 'kit_shipped', 'kit_received_by_patient', 'sample_in_transit', 'received_by_lab', 'lab_processing', 'lab_complete', 'awaiting_clinician_review', 'clinician_approved', 'clinician_rejected', 'results_released', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."package_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('unpaid', 'paid', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payout_account_type" AS ENUM('ach', 'wire', 'invoice');--> statement-breakpoint
CREATE TYPE "public"."shipment_direction" AS ENUM('outbound_to_patient', 'inbound_to_lab');--> statement-breakpoint
CREATE TYPE "public"."shipping_method" AS ENUM('ground', 'two_day', 'overnight');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'invited', 'suspended');--> statement-breakpoint
CREATE TABLE "business_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"auth0_org_id" text,
	"status" "business_unit_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinician_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"doctor_user_id" uuid,
	"decision" "clinician_decision",
	"interpretation" text,
	"recommendations" text,
	"ai_draft" text,
	"ai_model" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"account_name" text NOT NULL,
	"account_type" "payout_account_type" DEFAULT 'invoice' NOT NULL,
	"account_reference" text NOT NULL,
	"billing_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fulfillment_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"fulfillment_account_id" uuid,
	"amount_cents" integer NOT NULL,
	"status" charge_status DEFAULT 'pending' NOT NULL,
	"batch_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"test_type_id" uuid NOT NULL,
	"kit_number" integer NOT NULL,
	"qr_token" text NOT NULL,
	"status" "kit_status" DEFAULT 'awaiting_fulfillment' NOT NULL,
	"external_kit_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kit_id" uuid NOT NULL,
	"lab_user_id" uuid,
	"file_id" uuid,
	"summary" text,
	"received_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title" text NOT NULL,
	"headline" text,
	"body_html" text NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_path" text,
	"order_id" uuid,
	"read_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kit_id" uuid,
	"actor_user_id" uuid,
	"actor_role" "actor_role" NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status",
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"reported_by_user_id" uuid,
	"reason" "order_issue_reason" NOT NULL,
	"detail" text,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"patient_user_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"price_cents" integer NOT NULL,
	"payment_status" "payment_status" DEFAULT 'unpaid' NOT NULL,
	"payment_reference" text,
	"shipping_address" jsonb NOT NULL,
	"shipping_method" "shipping_method" DEFAULT 'ground' NOT NULL,
	"external_fulfillment_id" text,
	"requires_clinician" boolean DEFAULT false NOT NULL,
	"results_released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "package_test_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"test_type_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"focus_area" text,
	"price_cents" integer NOT NULL,
	"requires_clinician" boolean DEFAULT false NOT NULL,
	"status" "package_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"auth0_user_id" text,
	"name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"direction" "shipment_direction" NOT NULL,
	"carrier" text,
	"tracking_number" text,
	"to_address" jsonb,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sample_type" text DEFAULT 'blood' NOT NULL,
	"turnaround_days" integer DEFAULT 5 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"auth0_user_id" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinician_reviews" ADD CONSTRAINT "clinician_reviews_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinician_reviews" ADD CONSTRAINT "clinician_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinician_reviews" ADD CONSTRAINT "clinician_reviews_doctor_user_id_users_id_fk" FOREIGN KEY ("doctor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_accounts" ADD CONSTRAINT "fulfillment_accounts_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_accounts" ADD CONSTRAINT "fulfillment_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_charges" ADD CONSTRAINT "fulfillment_charges_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_charges" ADD CONSTRAINT "fulfillment_charges_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_charges" ADD CONSTRAINT "fulfillment_charges_fulfillment_account_id_fulfillment_accounts_id_fk" FOREIGN KEY ("fulfillment_account_id") REFERENCES "public"."fulfillment_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kits" ADD CONSTRAINT "kits_test_type_id_test_types_id_fk" FOREIGN KEY ("test_type_id") REFERENCES "public"."test_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_lab_user_id_users_id_fk" FOREIGN KEY ("lab_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_pages" ADD CONSTRAINT "marketing_pages_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_kit_id_kits_id_fk" FOREIGN KEY ("kit_id") REFERENCES "public"."kits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_issues" ADD CONSTRAINT "order_issues_reported_by_user_id_users_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_patient_user_id_users_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_test_types" ADD CONSTRAINT "package_test_types_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_test_types" ADD CONSTRAINT "package_test_types_test_type_id_test_types_id_fk" FOREIGN KEY ("test_type_id") REFERENCES "public"."test_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_types" ADD CONSTRAINT "test_types_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_units_slug_key" ON "business_units" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "clinician_reviews_order_key" ON "clinician_reviews" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "clinician_reviews_bu_pending_idx" ON "clinician_reviews" USING btree ("business_unit_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key_key" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_accounts_user_key" ON "fulfillment_accounts" USING btree ("business_unit_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_charges_order_key" ON "fulfillment_charges" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "fulfillment_charges_batch_idx" ON "fulfillment_charges" USING btree ("business_unit_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "kits_qr_token_key" ON "kits" USING btree ("qr_token");--> statement-breakpoint
CREATE UNIQUE INDEX "kits_order_number_key" ON "kits" USING btree ("order_id","kit_number");--> statement-breakpoint
CREATE INDEX "kits_bu_status_idx" ON "kits" USING btree ("business_unit_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_results_kit_key" ON "lab_results" USING btree ("kit_id");--> statement-breakpoint
CREATE INDEX "lab_results_order_idx" ON "lab_results" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_pages_bu_version_key" ON "marketing_pages" USING btree ("business_unit_id","version");--> statement-breakpoint
CREATE INDEX "marketing_pages_bu_published_idx" ON "marketing_pages" USING btree ("business_unit_id","is_published");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_bu_role_key" ON "memberships" USING btree ("user_id","business_unit_id","role");--> statement-breakpoint
CREATE INDEX "memberships_bu_role_idx" ON "memberships" USING btree ("business_unit_id","role");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","created_at");--> statement-breakpoint
CREATE INDEX "order_issues_order_idx" ON "order_issues" USING btree ("order_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_bu_status_idx" ON "orders" USING btree ("business_unit_id","status");--> statement-breakpoint
CREATE INDEX "orders_patient_idx" ON "orders" USING btree ("patient_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "package_test_types_key" ON "package_test_types" USING btree ("package_id","test_type_id");--> statement-breakpoint
CREATE INDEX "packages_bu_status_idx" ON "packages" USING btree ("business_unit_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_auth0_key" ON "platform_admins" USING btree ("auth0_user_id");--> statement-breakpoint
CREATE INDEX "shipments_order_idx" ON "shipments" USING btree ("order_id","direction");--> statement-breakpoint
CREATE INDEX "test_types_bu_idx" ON "test_types" USING btree ("business_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth0_key" ON "users" USING btree ("auth0_user_id");