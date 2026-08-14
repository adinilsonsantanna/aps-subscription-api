-- Preserve legacy subscription rows while allowing Shopify-native webhook data
-- to arrive incrementally.
ALTER TABLE "Subscription"
  ALTER COLUMN "shopifyCustomerId" DROP NOT NULL,
  ALTER COLUMN "shopifyProductId" DROP NOT NULL,
  ALTER COLUMN "shopifyVariantId" DROP NOT NULL,
  ALTER COLUMN "gateway" DROP NOT NULL,
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" DROP NOT NULL,
  ALTER COLUMN "nextBillingAt" DROP NOT NULL,
  ADD COLUMN "shopifyContractId" TEXT,
  ADD COLUMN "shopifyOriginOrderId" TEXT,
  ADD COLUMN "currencyCode" TEXT,
  ADD COLUMN "billingInterval" TEXT,
  ADD COLUMN "billingIntervalCount" INTEGER,
  ADD COLUMN "deliveryInterval" TEXT,
  ADD COLUMN "deliveryIntervalCount" INTEGER,
  ADD COLUMN "lastPaymentStatus" TEXT;

ALTER TABLE "WebhookEvent"
  ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "processedAt" TIMESTAMP(3),
  ADD COLUMN "errorMessage" TEXT;

CREATE TABLE "SubscriptionBillingAttempt" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "shopifyContractId" TEXT NOT NULL,
  "shopifyBillingAttemptId" TEXT,
  "idempotencyKey" TEXT,
  "status" TEXT NOT NULL,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "shopifyOrderId" TEXT,
  "nextActionUrl" TEXT,
  "attemptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionBillingAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_shopId_shopifyContractId_key"
  ON "Subscription"("shopId", "shopifyContractId");
CREATE INDEX "Subscription_shopifyContractId_idx"
  ON "Subscription"("shopifyContractId");
CREATE UNIQUE INDEX "SubscriptionBillingAttempt_shopId_shopifyBillingAttemptId_key"
  ON "SubscriptionBillingAttempt"("shopId", "shopifyBillingAttemptId");
CREATE UNIQUE INDEX "SubscriptionBillingAttempt_shopId_idempotencyKey_key"
  ON "SubscriptionBillingAttempt"("shopId", "idempotencyKey");
CREATE INDEX "SubscriptionBillingAttempt_shopId_shopifyContractId_idx"
  ON "SubscriptionBillingAttempt"("shopId", "shopifyContractId");
CREATE INDEX "SubscriptionBillingAttempt_subscriptionId_status_idx"
  ON "SubscriptionBillingAttempt"("subscriptionId", "status");

ALTER TABLE "SubscriptionBillingAttempt"
  ADD CONSTRAINT "SubscriptionBillingAttempt_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionBillingAttempt"
  ADD CONSTRAINT "SubscriptionBillingAttempt_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
