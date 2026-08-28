ALTER TABLE "SubscriptionBillingAttempt"
  ADD COLUMN "cycleOriginTime" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "orderAmount" DECIMAL(10,2),
  ADD COLUMN "orderCurrencyCode" TEXT,
  ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reconciliationError" TEXT;

CREATE INDEX "SubscriptionBillingAttempt_subscriptionId_cycleOriginTime_status_idx"
  ON "SubscriptionBillingAttempt"("subscriptionId", "cycleOriginTime", "status");

CREATE TABLE "BillingReconciliationAudit" (
  "id" TEXT NOT NULL, "shopId" TEXT NOT NULL, "subscriptionId" TEXT NOT NULL,
  "billingAttemptId" TEXT NOT NULL, "shopifyBillingAttemptId" TEXT NOT NULL,
  "shopifyOrderId" TEXT NOT NULL, "cycleOriginTime" TIMESTAMP(3) NOT NULL,
  "correlationId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL,
  "before" JSONB NOT NULL, "after" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingReconciliationAudit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BillingReconciliationAudit_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingReconciliationAudit_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingReconciliationAudit_billingAttemptId_fkey" FOREIGN KEY ("billingAttemptId") REFERENCES "SubscriptionBillingAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingReconciliationAudit_billingAttemptId_key" ON "BillingReconciliationAudit"("billingAttemptId");
CREATE UNIQUE INDEX "BillingReconciliationAudit_shopId_shopifyBillingAttemptId_cycleOriginTime_key" ON "BillingReconciliationAudit"("shopId", "shopifyBillingAttemptId", "cycleOriginTime");
CREATE INDEX "BillingReconciliationAudit_subscriptionId_cycleOriginTime_idx" ON "BillingReconciliationAudit"("subscriptionId", "cycleOriginTime");
CREATE INDEX "BillingReconciliationAudit_correlationId_idx" ON "BillingReconciliationAudit"("correlationId");

-- Rollback (manual, only before application code depends on these columns):
-- DROP INDEX "SubscriptionBillingAttempt_subscriptionId_cycleOriginTime_status_idx";
-- DROP TABLE "BillingReconciliationAudit";
-- ALTER TABLE "SubscriptionBillingAttempt"
--   DROP COLUMN "cycleOriginTime",
--   DROP COLUMN "completedAt",
--   DROP COLUMN "orderAmount",
--   DROP COLUMN "orderCurrencyCode",
--   DROP COLUMN "reconciliationStatus",
--   DROP COLUMN "reconciliationAttempts",
--   DROP COLUMN "reconciliationError";
