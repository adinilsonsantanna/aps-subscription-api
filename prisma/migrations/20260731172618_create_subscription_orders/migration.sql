-- CreateTable
CREATE TABLE "SubscriptionOrder" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "shopifyOrderId" TEXT,
    "gatewayOrderId" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubscriptionOrder_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "SubscriptionOrder" ADD CONSTRAINT "SubscriptionOrder_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
