import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const migrationPath = join(
  process.cwd(),
  "prisma/migrations/20260831210000_add_subscription_line_to_billing_reconciliation_audit/migration.sql",
);

test("reconciliation audit migration matches the existing optional SubscriptionLine relation", async () => {
  const [schema, originalMigration, correctiveMigration] = await Promise.all([
    readFile(join(process.cwd(), "prisma/schema.prisma"), "utf8"),
    readFile(join(process.cwd(), "prisma/migrations/20260828120000_reconcile_shopify_billing_attempts/migration.sql"), "utf8"),
    readFile(migrationPath, "utf8"),
  ]);

  assert.match(schema, /subscriptionLine\s+SubscriptionLine\?\s+@relation\(fields: \[subscriptionLineId\], references: \[id\]\)/);
  assert.match(schema, /subscriptionLineId\s+String\?/);
  assert.doesNotMatch(originalMigration, /subscriptionLineId/);
  assert.match(correctiveMigration, /ALTER TABLE "BillingReconciliationAudit"\s+ADD COLUMN "subscriptionLineId" TEXT;/);
  assert.match(correctiveMigration, /CONSTRAINT "BillingReconciliationAudit_subscriptionLineId_fkey"\s+FOREIGN KEY \("subscriptionLineId"\) REFERENCES "SubscriptionLine"\("id"\)\s+ON DELETE SET NULL ON UPDATE CASCADE;/);
  assert.doesNotMatch(correctiveMigration, /NOT NULL|UPDATE\s+"BillingReconciliationAudit"|DROP\s+/i);
});
