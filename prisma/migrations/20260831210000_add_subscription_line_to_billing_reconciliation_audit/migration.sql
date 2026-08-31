ALTER TABLE "BillingReconciliationAudit"
  ADD COLUMN "subscriptionLineId" TEXT;

ALTER TABLE "BillingReconciliationAudit"
  ADD CONSTRAINT "BillingReconciliationAudit_subscriptionLineId_fkey"
  FOREIGN KEY ("subscriptionLineId") REFERENCES "SubscriptionLine"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
