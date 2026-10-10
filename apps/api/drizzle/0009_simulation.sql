ALTER TABLE "users" ADD COLUMN "is_mock" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "is_mock" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "orders_bu_mock_idx" ON "orders" ("business_unit_id") WHERE "is_mock";
