-- Pay-first guest checkout (phase 2).
--
-- * guest_activation: the order was placed before the shopper had an account. The activation
--   invite is withheld until payment clears.
-- * activation_invite_sent_at: claimed before the invite is sent so a replayed payment event and
--   the retry sweep cannot send it twice; cleared again if sending fails so the sweep retries.

ALTER TABLE "orders" ADD COLUMN "guest_activation" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "activation_invite_sent_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "orders_pending_activation_idx" ON "orders" ("created_at")
  WHERE "guest_activation" = true AND "activation_invite_sent_at" IS NULL;
