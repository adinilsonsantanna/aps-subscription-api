/*
  Warnings:

  - A unique constraint covering the columns `[shopifyShopId]` on the table `Shop` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "gateway" TEXT NOT NULL DEFAULT 'mercado_pago',
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "shopifyShopId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopifyShopId_key" ON "Shop"("shopifyShopId");
