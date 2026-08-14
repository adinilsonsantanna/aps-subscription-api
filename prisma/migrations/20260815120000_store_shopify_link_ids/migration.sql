-- Add correlation identifiers without changing historical records.
ALTER TABLE "WebhookEvent" ADD COLUMN "shopifyEventId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "shopifyRevisionId" TEXT;

CREATE TABLE "SubscriptionLine" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "shopifySubscriptionLineId" TEXT NOT NULL,
  "shopifyProductId" TEXT,
  "shopifyVariantId" TEXT,
  "shopifySellingPlanId" TEXT,
  "quantity" INTEGER NOT NULL,
  "currentPrice" DECIMAL(10,2),
  "currencyCode" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookEvent_shopifyEventId_idx" ON "WebhookEvent"("shopifyEventId");
CREATE UNIQUE INDEX "SubscriptionLine_subscriptionId_shopifySubscriptionLineId_key" ON "SubscriptionLine"("subscriptionId", "shopifySubscriptionLineId");
CREATE INDEX "SubscriptionLine_shopifyProductId_idx" ON "SubscriptionLine"("shopifyProductId");
CREATE INDEX "SubscriptionLine_shopifyVariantId_idx" ON "SubscriptionLine"("shopifyVariantId");
CREATE INDEX "SubscriptionLine_shopifySellingPlanId_idx" ON "SubscriptionLine"("shopifySellingPlanId");
ALTER TABLE "SubscriptionLine" ADD CONSTRAINT "SubscriptionLine_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
