-- Scope 7: additive retry settings, billing cycles, leased jobs and notification outbox.
-- Rollback (only before application use): drop NotificationOutbox, BillingRetryJob,
-- BillingRetryCycle, BillingRetrySettings, then the four enum types created below.
CREATE TYPE "RetryKind" AS ENUM ('INVENTORY', 'PAYMENT');
CREATE TYPE "RetryJobStatus" AS ENUM ('PENDING', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'EXHAUSTED', 'SKIPPED', 'UNCERTAIN');
CREATE TYPE "RetryFailureAction" AS ENUM ('PAUSE_AND_NOTIFY', 'CANCEL_AND_NOTIFY', 'SKIP_AND_NOTIFY');
CREATE TYPE "TeamNotificationFrequency" AS ENUM ('IMMEDIATELY', 'DAILY_SUMMARY', 'WEEKLY_SUMMARY', 'NEVER');

CREATE TABLE "BillingRetrySettings" (
  "shopId" TEXT PRIMARY KEY, "paymentRetryAttempts" INTEGER NOT NULL DEFAULT 3,
  "paymentRetryDays" INTEGER NOT NULL DEFAULT 2, "paymentFailureAction" "RetryFailureAction" NOT NULL DEFAULT 'PAUSE_AND_NOTIFY',
  "inventoryRetryAttempts" INTEGER NOT NULL DEFAULT 5, "inventoryRetryDays" INTEGER NOT NULL DEFAULT 1,
  "inventoryFailureAction" "RetryFailureAction" NOT NULL DEFAULT 'SKIP_AND_NOTIFY',
  "teamNotificationFrequency" "TeamNotificationFrequency" NOT NULL DEFAULT 'WEEKLY_SUMMARY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingRetrySettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingRetrySettings_payment_attempts_check" CHECK ("paymentRetryAttempts" BETWEEN 0 AND 10),
  CONSTRAINT "BillingRetrySettings_payment_days_check" CHECK ("paymentRetryDays" BETWEEN 1 AND 14),
  CONSTRAINT "BillingRetrySettings_inventory_attempts_check" CHECK ("inventoryRetryAttempts" BETWEEN 0 AND 10),
  CONSTRAINT "BillingRetrySettings_inventory_days_check" CHECK ("inventoryRetryDays" BETWEEN 1 AND 14)
);
CREATE TABLE "BillingRetryCycle" (
  "id" TEXT PRIMARY KEY, "shopId" TEXT NOT NULL, "subscriptionId" TEXT NOT NULL, "billingCycleAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "finalAction" "RetryFailureAction", "finalActionAt" TIMESTAMP(3),
  "finalActionStatus" TEXT NOT NULL DEFAULT 'none', "finalActionClaimedAt" TIMESTAMP(3), "finalActionLeaseExpiresAt" TIMESTAMP(3), "finalActionError" TEXT,
  "nextBillingAdvanced" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingRetryCycle_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingRetryCycle_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BillingRetryCycle_subscriptionId_billingCycleAt_key" ON "BillingRetryCycle"("subscriptionId", "billingCycleAt");
CREATE INDEX "BillingRetryCycle_shopId_status_idx" ON "BillingRetryCycle"("shopId", "status");
CREATE INDEX "BillingRetryCycle_finalActionStatus_finalActionLeaseExpiresAt_idx" ON "BillingRetryCycle"("finalActionStatus", "finalActionLeaseExpiresAt");
CREATE TABLE "BillingRetryJob" (
  "id" TEXT PRIMARY KEY, "shopId" TEXT NOT NULL, "subscriptionId" TEXT NOT NULL, "cycleId" TEXT NOT NULL,
  "kind" "RetryKind" NOT NULL, "attemptNumber" INTEGER NOT NULL, "maxRetries" INTEGER NOT NULL,
  "status" "RetryJobStatus" NOT NULL DEFAULT 'PENDING', "scheduledAt" TIMESTAMP(3) NOT NULL, "claimedAt" TIMESTAMP(3),
  "leaseExpiresAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "idempotencyKey" TEXT NOT NULL,
  "errorCode" TEXT, "errorMessage" TEXT, "inventoryResult" JSONB, "externalAttemptId" TEXT, "externalOrderId" TEXT,
  "reconciliationCount" INTEGER NOT NULL DEFAULT 0, "maxReconciliations" INTEGER NOT NULL DEFAULT 12,
  "firstUncertainAt" TIMESTAMP(3), "lastReconciledAt" TIMESTAMP(3), "reconciliationDeadlineAt" TIMESTAMP(3),
  "finalAction" "RetryFailureAction", "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BillingRetryJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingRetryJob_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingRetryJob_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BillingRetryCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BillingRetryJob_attempt_check" CHECK ("attemptNumber" >= 0 AND "maxRetries" BETWEEN 0 AND 10),
  CONSTRAINT "BillingRetryJob_reconciliation_check" CHECK ("reconciliationCount" >= 0 AND "maxReconciliations" BETWEEN 1 AND 48)
);
CREATE UNIQUE INDEX "BillingRetryJob_idempotencyKey_key" ON "BillingRetryJob"("idempotencyKey");
CREATE UNIQUE INDEX "BillingRetryJob_cycleId_kind_attemptNumber_key" ON "BillingRetryJob"("cycleId", "kind", "attemptNumber");
CREATE INDEX "BillingRetryJob_status_scheduledAt_idx" ON "BillingRetryJob"("status", "scheduledAt");
CREATE INDEX "BillingRetryJob_status_leaseExpiresAt_idx" ON "BillingRetryJob"("status", "leaseExpiresAt");
CREATE INDEX "BillingRetryJob_subscriptionId_kind_status_idx" ON "BillingRetryJob"("subscriptionId", "kind", "status");
CREATE UNIQUE INDEX "BillingRetryJob_one_actionable_kind_per_cycle_key" ON "BillingRetryJob"("cycleId", "kind") WHERE "status" IN ('PENDING','CLAIMED','UNCERTAIN');
CREATE TABLE "NotificationOutbox" (
  "id" TEXT PRIMARY KEY, "shopId" TEXT NOT NULL, "cycleId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "frequency" "TeamNotificationFrequency" NOT NULL, "eventType" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "availableAt" TIMESTAMP(3) NOT NULL, "sentAt" TIMESTAMP(3), "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationOutbox_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationOutbox_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BillingRetryCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NotificationOutbox_idempotencyKey_key" ON "NotificationOutbox"("idempotencyKey");
CREATE INDEX "NotificationOutbox_status_availableAt_idx" ON "NotificationOutbox"("status", "availableAt");
CREATE INDEX "NotificationOutbox_shopId_frequency_availableAt_idx" ON "NotificationOutbox"("shopId", "frequency", "availableAt");
