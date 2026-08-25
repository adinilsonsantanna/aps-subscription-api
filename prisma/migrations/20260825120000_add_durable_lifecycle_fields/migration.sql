-- AlterTable
ALTER TABLE "Shop" ADD COLUMN "lastInstalledAt" TIMESTAMP(3),
ADD COLUMN "lastUninstalledAt" TIMESTAMP(3),
ADD COLUMN "installationGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "Shop_domain_shopifyShopId_installationGeneration_idx"
ON "Shop"("domain", "shopifyShopId", "installationGeneration");

CREATE INDEX "Shop_isActive_lastInstalledAt_lastUninstalledAt_idx"
ON "Shop"("isActive", "lastInstalledAt", "lastUninstalledAt");
