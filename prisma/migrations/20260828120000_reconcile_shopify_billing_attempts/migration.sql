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

-- Rollback (manual, only before application code depends on these columns):
-- DROP INDEX "SubscriptionBillingAttempt_subscriptionId_cycleOriginTime_status_idx";
-- ALTER TABLE "SubscriptionBillingAttempt"
--   DROP COLUMN "cycleOriginTime",
--   DROP COLUMN "completedAt",
--   DROP COLUMN "orderAmount",
--   DROP COLUMN "orderCurrencyCode",
--   DROP COLUMN "reconciliationStatus",
--   DROP COLUMN "reconciliationAttempts",
--   DROP COLUMN "reconciliationError";
