-- Nullable idempotency key protects new Shopify-native initial orders without
-- changing or deleting historical rows (PostgreSQL permits multiple NULLs).
ALTER TABLE "SubscriptionOrder" ADD COLUMN "shopifyOrderKey" TEXT;
CREATE UNIQUE INDEX "SubscriptionOrder_shopifyOrderKey_key" ON "SubscriptionOrder"("shopifyOrderKey");
