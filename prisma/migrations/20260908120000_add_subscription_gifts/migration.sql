-- Migration aditiva: configuração de brindes (CONFIGURAR BRINDES) e registro de decisões por pedido.
-- Não altera tabelas existentes; apenas cria enums, tabelas e índices novos.

CREATE TYPE "SubscriptionGiftSchedule" AS ENUM ('FIRST_ORDER', 'RENEWALS', 'BOTH');

CREATE TYPE "SubscriptionGiftSelectionMode" AS ENUM ('FIXED_VARIANT', 'RANDOM_GROUP');

CREATE TYPE "SubscriptionGiftJobStatus" AS ENUM ('PENDING', 'COMMIT_PENDING', 'COMMITTED', 'SKIPPED', 'FAILED', 'UNCERTAIN');

CREATE TABLE "SubscriptionGiftSettings" (
    "shopId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "schedule" "SubscriptionGiftSchedule" NOT NULL DEFAULT 'FIRST_ORDER',
    "selectionMode" "SubscriptionGiftSelectionMode" NOT NULL DEFAULT 'FIXED_VARIANT',
    "fixedVariantId" TEXT,
    "fixedProductId" TEXT,
    "fixedTitle" TEXT,
    "fixedSku" TEXT,
    "variantPool" JSONB NOT NULL DEFAULT '[]',
    "maxPoolSize" INTEGER NOT NULL DEFAULT 50,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionGiftSettings_pkey" PRIMARY KEY ("shopId")
);

CREATE INDEX "SubscriptionGiftSettings_shopId_enabled_idx" ON "SubscriptionGiftSettings"("shopId", "enabled");

ALTER TABLE "SubscriptionGiftSettings" ADD CONSTRAINT "SubscriptionGiftSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SubscriptionGiftJob" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderKey" TEXT NOT NULL,
    "scheduleKind" "SubscriptionGiftSchedule" NOT NULL,
    "orderProcessedAt" TIMESTAMP(3),
    "orderCurrencyCode" TEXT,
    "subscriptionId" TEXT,
    "status" "SubscriptionGiftJobStatus" NOT NULL DEFAULT 'PENDING',
    "chosenVariantId" TEXT,
    "chosenVariantSku" TEXT,
    "chosenProductId" TEXT,
    "chosenTitle" TEXT,
    "candidatesWithStock" INTEGER NOT NULL DEFAULT 0,
    "candidatePoolSnapshot" JSONB,
    "installationGeneration" INTEGER NOT NULL DEFAULT 0,
    "resultCode" TEXT,
    "resultMessage" TEXT,
    "orderEditId" TEXT,
    "calculatedOrderId" TEXT,
    "giftLineDeterminativeId" TEXT,
    "giftLineIdentifier" TEXT,
    "orderTotalBefore" DECIMAL(20,2),
    "orderShippingBefore" DECIMAL(20,2),
    "orderTotalAfterComputed" DECIMAL(20,2),
    "commitIntentPersistedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "claimToken" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "reviewRequiredAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionGiftJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionGiftJob_shopId_orderKey_key" ON "SubscriptionGiftJob"("shopId", "orderKey");

CREATE INDEX "SubscriptionGiftJob_status_leaseExpiresAt_idx" ON "SubscriptionGiftJob"("status", "leaseExpiresAt");

CREATE INDEX "SubscriptionGiftJob_status_availableAt_idx" ON "SubscriptionGiftJob"("status", "availableAt");

CREATE INDEX "SubscriptionGiftJob_shopId_createdAt_idx" ON "SubscriptionGiftJob"("shopId", "createdAt");

ALTER TABLE "SubscriptionGiftJob" ADD CONSTRAINT "SubscriptionGiftJob_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;