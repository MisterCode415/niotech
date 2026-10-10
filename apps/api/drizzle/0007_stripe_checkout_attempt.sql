ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "checkout_attempt" integer DEFAULT 1 NOT NULL;
