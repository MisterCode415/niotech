ALTER TABLE "packages" ADD COLUMN "internal_reference" text;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "external_product_id" text;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "external_purchase_url" text;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "supersedes_package_id" uuid;
--> statement-breakpoint
ALTER TABLE "packages" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "packages_supersedes_package_id_packages_id_fk"
  FOREIGN KEY ("supersedes_package_id") REFERENCES "public"."packages"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "packages_bu_internal_reference_version_key"
  ON "packages" USING btree ("business_unit_id", "internal_reference", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "packages_bu_external_product_key"
  ON "packages" USING btree ("business_unit_id", "external_product_id");
--> statement-breakpoint

ALTER TABLE "orders" ADD COLUMN "package_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_source" text DEFAULT 'native' NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "external_order_id" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "external_payment_id" text;
--> statement-breakpoint
UPDATE "orders" AS o
SET "package_snapshot" = jsonb_build_object(
  'packageName', p."name",
  'packageVersion', p."version",
  'priceCents', o."price_cents",
  'requiresClinician', o."requires_clinician",
  'internalReference', p."internal_reference",
  'externalProductId', p."external_product_id",
  'tests', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'testTypeId', tt."id",
      'name', tt."name",
      'sampleType', tt."sample_type",
      'turnaroundDays', tt."turnaround_days",
      'quantity', ptt."quantity"
    ) ORDER BY tt."name")
    FROM "package_test_types" ptt
    JOIN "test_types" tt ON tt."id" = ptt."test_type_id"
    WHERE ptt."package_id" = p."id"
  ), '[]'::jsonb)
)
FROM "packages" p
WHERE p."id" = o."package_id";
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "package_snapshot" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_bu_source_external_key"
  ON "orders" USING btree ("business_unit_id", "order_source", "external_order_id");
