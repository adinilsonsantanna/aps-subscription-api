-- AlterTable
ALTER TABLE "Shop" ALTER COLUMN "gateway" SET DEFAULT 'stripe';

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripePaymentMethodId" TEXT;
