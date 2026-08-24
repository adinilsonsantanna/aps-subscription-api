ALTER TABLE "NotificationOutbox" ALTER COLUMN "cycleId" DROP NOT NULL;
ALTER TABLE "NotificationOutbox" ADD COLUMN "recipientType" TEXT NOT NULL DEFAULT 'team',
ADD COLUMN "recipientEmail" TEXT,
ADD COLUMN "subject" TEXT,
ADD COLUMN "htmlBody" TEXT,
ADD COLUMN "textBody" TEXT,
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN "claimedAt" TIMESTAMP(3),
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "providerMessageId" TEXT,
ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "NotificationOutbox" ADD COLUMN "externalSucceededAt" TIMESTAMP(3),
ADD COLUMN "deliveryUncertainAt" TIMESTAMP(3),
ADD COLUMN "deliveryDeadlineAt" TIMESTAMP(3),
ADD COLUMN "includedEventIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Subscription" ADD COLUMN "shopifyCustomerEmail" TEXT;

CREATE TABLE "NotificationEvent" (
  "id" TEXT NOT NULL, "shopId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL, "recipientEmail" TEXT, "frequency" "TeamNotificationFrequency" NOT NULL,
  "windowKey" TEXT, "windowEndAt" TIMESTAMP(3), "includedInOutboxId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationEvent_idempotencyKey_key" ON "NotificationEvent"("idempotencyKey");
CREATE INDEX "NotificationEvent_shopId_frequency_windowKey_idx" ON "NotificationEvent"("shopId", "frequency", "windowKey");
CREATE INDEX "NotificationEvent_includedInOutboxId_windowEndAt_idx" ON "NotificationEvent"("includedInOutboxId", "windowEndAt");
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationEvent" ADD CONSTRAINT "NotificationEvent_includedInOutboxId_fkey" FOREIGN KEY ("includedInOutboxId") REFERENCES "NotificationOutbox"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationOutbox" DROP CONSTRAINT "NotificationOutbox_cycleId_fkey";
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "BillingRetryCycle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "NotificationOutbox_providerMessageId_key" ON "NotificationOutbox"("providerMessageId");
CREATE INDEX "NotificationOutbox_status_leaseExpiresAt_idx" ON "NotificationOutbox"("status", "leaseExpiresAt");

CREATE TABLE "NotificationSettings" (
  "shopId" TEXT NOT NULL, "fromName" TEXT, "fromEmail" TEXT, "replyTo" TEXT,
  "teamEmails" TEXT[] NOT NULL, "teamFrequency" "TeamNotificationFrequency" NOT NULL DEFAULT 'WEEKLY_SUMMARY',
  "customerNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "paymentFailedEnabled" BOOLEAN NOT NULL DEFAULT true, "retryScheduledEnabled" BOOLEAN NOT NULL DEFAULT true,
  "inventoryFailedEnabled" BOOLEAN NOT NULL DEFAULT true, "inventoryRetryEnabled" BOOLEAN NOT NULL DEFAULT true,
  "pausedEnabled" BOOLEAN NOT NULL DEFAULT true, "cancelledEnabled" BOOLEAN NOT NULL DEFAULT true,
  "renewalSucceededEnabled" BOOLEAN NOT NULL DEFAULT true, "lastTestAt" TIMESTAMP(3), "activeSendingDomainId" TEXT,
  "activeFromName" TEXT, "activeFromEmail" TEXT, "activeReplyTo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("shopId")
);
CREATE UNIQUE INDEX "NotificationSettings_activeSendingDomainId_key" ON "NotificationSettings"("activeSendingDomainId");

CREATE TABLE "SendingDomain" (
  "id" TEXT NOT NULL, "shopId" TEXT NOT NULL, "domain" TEXT NOT NULL, "providerDomainId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'not_configured', "sendingVerified" BOOLEAN NOT NULL DEFAULT false,
  "encryptedApiKey" TEXT, "apiKeyId" TEXT, "pendingEncryptedApiKey" TEXT, "pendingApiKeyId" TEXT,
  "previousApiKeyId" TEXT, "credentialStatus" TEXT NOT NULL DEFAULT 'ACTIVE', "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  "lastCheckedAt" TIMESTAMP(3), "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SendingDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SendingDomain_domain_key" ON "SendingDomain"("domain");
CREATE UNIQUE INDEX "SendingDomain_providerDomainId_key" ON "SendingDomain"("providerDomainId");
CREATE UNIQUE INDEX "SendingDomain_shopId_domain_key" ON "SendingDomain"("shopId", "domain");
CREATE INDEX "SendingDomain_shopId_status_idx" ON "SendingDomain"("shopId", "status");
ALTER TABLE "SendingDomain" ADD COLUMN "credentialOperationId" TEXT,
ADD COLUMN "credentialClaimedAt" TIMESTAMP(3),
ADD COLUMN "credentialLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "credentialAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "credentialError" TEXT;
CREATE INDEX "SendingDomain_credentialStatus_credentialLeaseExpiresAt_idx" ON "SendingDomain"("credentialStatus", "credentialLeaseExpiresAt");

CREATE TABLE "SendingCredentialCleanupJob" (
  "id" TEXT NOT NULL, "sendingDomainId" TEXT NOT NULL, "providerApiKeyId" TEXT NOT NULL,
  "reason" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 12, "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3), "leaseExpiresAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SendingCredentialCleanupJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SendingCredentialCleanupJob_sendingDomainId_providerApiKeyId_reason_key" ON "SendingCredentialCleanupJob"("sendingDomainId", "providerApiKeyId", "reason");
CREATE INDEX "SendingCredentialCleanupJob_status_availableAt_idx" ON "SendingCredentialCleanupJob"("status", "availableAt");
CREATE INDEX "SendingCredentialCleanupJob_status_leaseExpiresAt_idx" ON "SendingCredentialCleanupJob"("status", "leaseExpiresAt");
ALTER TABLE "SendingCredentialCleanupJob" ADD CONSTRAINT "SendingCredentialCleanupJob_sendingDomainId_fkey" FOREIGN KEY ("sendingDomainId") REFERENCES "SendingDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SendingDomainDnsRecord" (
  "id" TEXT NOT NULL, "sendingDomainId" TEXT NOT NULL, "purpose" TEXT NOT NULL, "type" TEXT NOT NULL,
  "name" TEXT NOT NULL, "value" TEXT NOT NULL, "priority" INTEGER, "ttl" TEXT, "status" TEXT NOT NULL,
  "position" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SendingDomainDnsRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SendingDomainDnsRecord_sendingDomainId_position_key" ON "SendingDomainDnsRecord"("sendingDomainId", "position");

CREATE TABLE "NotificationDeliveryEvent" (
  "id" TEXT NOT NULL, "shopId" TEXT, "providerEventId" TEXT NOT NULL, "providerMessageId" TEXT,
  "providerDomainId" TEXT, "type" TEXT NOT NULL, "payload" JSONB NOT NULL, "occurredAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationDeliveryEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationDeliveryEvent_providerEventId_key" ON "NotificationDeliveryEvent"("providerEventId");
CREATE INDEX "NotificationDeliveryEvent_providerMessageId_idx" ON "NotificationDeliveryEvent"("providerMessageId");
CREATE INDEX "NotificationDeliveryEvent_providerDomainId_idx" ON "NotificationDeliveryEvent"("providerDomainId");
CREATE INDEX "NotificationDeliveryEvent_shopId_createdAt_idx" ON "NotificationDeliveryEvent"("shopId", "createdAt");

ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendingDomain" ADD CONSTRAINT "SendingDomain_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SendingDomainDnsRecord" ADD CONSTRAINT "SendingDomainDnsRecord_sendingDomainId_fkey" FOREIGN KEY ("sendingDomainId") REFERENCES "SendingDomain"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDeliveryEvent" ADD CONSTRAINT "NotificationDeliveryEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NotificationSettings" ADD CONSTRAINT "NotificationSettings_activeSendingDomainId_fkey" FOREIGN KEY ("activeSendingDomainId") REFERENCES "SendingDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
DROP INDEX IF EXISTS "BillingRetryJob_idempotencyKey_key";
CREATE UNIQUE INDEX "BillingRetryJob_shopId_idempotencyKey_key" ON "BillingRetryJob"("shopId", "idempotencyKey");
