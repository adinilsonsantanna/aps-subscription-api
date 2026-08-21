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
  "renewalSucceededEnabled" BOOLEAN NOT NULL DEFAULT true, "activeSendingDomainId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("shopId")
);
CREATE UNIQUE INDEX "NotificationSettings_activeSendingDomainId_key" ON "NotificationSettings"("activeSendingDomainId");

CREATE TABLE "SendingDomain" (
  "id" TEXT NOT NULL, "shopId" TEXT NOT NULL, "domain" TEXT NOT NULL, "providerDomainId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'not_configured', "sendingVerified" BOOLEAN NOT NULL DEFAULT false,
  "encryptedApiKey" TEXT, "apiKeyId" TEXT, "credentialVersion" INTEGER NOT NULL DEFAULT 1,
  "lastCheckedAt" TIMESTAMP(3), "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SendingDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SendingDomain_domain_key" ON "SendingDomain"("domain");
CREATE UNIQUE INDEX "SendingDomain_providerDomainId_key" ON "SendingDomain"("providerDomainId");
CREATE UNIQUE INDEX "SendingDomain_shopId_domain_key" ON "SendingDomain"("shopId", "domain");
CREATE INDEX "SendingDomain_shopId_status_idx" ON "SendingDomain"("shopId", "status");

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
