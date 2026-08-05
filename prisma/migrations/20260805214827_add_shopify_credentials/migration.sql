/*
  Warnings:

  - Added the required column `accessToken` to the `Shop` table without a default value. This is not possible if the table is not empty.
  - Added the required column `scopes` to the `Shop` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "accessToken" TEXT NOT NULL,
ADD COLUMN     "scopes" TEXT NOT NULL;
