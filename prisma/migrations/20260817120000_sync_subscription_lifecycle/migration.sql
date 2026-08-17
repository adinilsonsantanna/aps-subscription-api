ALTER TABLE "Subscription"
  ADD COLUMN "lastGatewayStatusEventAt" TIMESTAMP(3),
  ADD COLUMN "lastGatewayPaymentEventAt" TIMESTAMP(3);

CREATE TABLE "SubscriptionLifecycleAction" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "gateway" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "externalStatus" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "httpStatus" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SubscriptionLifecycleAction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionLifecycleAction_subscriptionId_idempotencyKey_key" ON "SubscriptionLifecycleAction"("subscriptionId", "idempotencyKey");
CREATE UNIQUE INDEX "SubscriptionLifecycleAction_one_pending_per_subscription_key" ON "SubscriptionLifecycleAction"("subscriptionId") WHERE "status" = 'pending';
CREATE INDEX "SubscriptionLifecycleAction_subscriptionId_idx" ON "SubscriptionLifecycleAction"("subscriptionId");
CREATE INDEX "SubscriptionLifecycleAction_status_idx" ON "SubscriptionLifecycleAction"("status");
ALTER TABLE "SubscriptionLifecycleAction" ADD CONSTRAINT "SubscriptionLifecycleAction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SubscriptionStatusHistory" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "previousStatus" TEXT,
  "newStatus" TEXT NOT NULL,
  "previousPaymentStatus" TEXT,
  "newPaymentStatus" TEXT,
  "source" TEXT NOT NULL,
  "sourceEventId" TEXT,
  "lifecycleActionId" TEXT,
  "actor" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionStatusHistory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SubscriptionStatusHistory_source_sourceEventId_key" ON "SubscriptionStatusHistory"("source", "sourceEventId");
CREATE INDEX "SubscriptionStatusHistory_subscriptionId_createdAt_idx" ON "SubscriptionStatusHistory"("subscriptionId", "createdAt");
CREATE INDEX "SubscriptionStatusHistory_lifecycleActionId_idx" ON "SubscriptionStatusHistory"("lifecycleActionId");
ALTER TABLE "SubscriptionStatusHistory" ADD CONSTRAINT "SubscriptionStatusHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionStatusHistory" ADD CONSTRAINT "SubscriptionStatusHistory_lifecycleActionId_fkey" FOREIGN KEY ("lifecycleActionId") REFERENCES "SubscriptionLifecycleAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
