-- Allow Shopify events to create a minimal subscription mirror before the
-- complete contract payload arrives. Existing values are preserved.
ALTER TABLE "Subscription"
  ALTER COLUMN "interval" DROP NOT NULL,
  ALTER COLUMN "intervalType" DROP NOT NULL;

-- Tie each billing attempt to its originating webhook so concurrent retries
-- cannot create duplicate attempts when Shopify omits attempt identifiers.
ALTER TABLE "SubscriptionBillingAttempt"
  ADD COLUMN "webhookEventId" TEXT;

CREATE UNIQUE INDEX "SubscriptionBillingAttempt_webhookEventId_key"
  ON "SubscriptionBillingAttempt"("webhookEventId");
