import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { AdministrativeBillingReconciliationService, AdministrativeReconciliationError, validateAdministrativeBillingReconciliation } from "../admin-billing-reconciliation";
import { sanitizedAdministrativeReconciliationPrismaError } from "../prisma-observability";
import { secureApiKeyMatches } from "../../../middlewares/apiAuth";

const input = { shopDomain: "one.myshopify.com", shopId: "gid://shopify/Shop/1", subscriptionContractId: "gid://shopify/SubscriptionContract/10", subscriptionBillingAttemptId: "gid://shopify/SubscriptionBillingAttempt/20", shopifyOrderId: "gid://shopify/Order/30", cycleOriginTime: "2026-09-27T16:00:00.000Z", status: "succeeded", amount: "50.19", currencyCode: "BRL", attemptedAt: "2026-08-28T12:00:01.000Z", completedAt: "2026-08-28T12:00:01.000Z", test: true, gateway: "bogus", correlationId: "scope9-live-cycle", dryRun: false } as const;
function fixture() {
  const shop = { id: "shop-1", domain: input.shopDomain, isActive: true, shopifyShopId: input.shopId }, subscription = { id: "sub-1", shopId: shop.id }, attempt: any = { id: "attempt-1", shopId: shop.id, subscriptionId: subscription.id, shopifyContractId: input.subscriptionContractId, shopifyBillingAttemptId: input.subscriptionBillingAttemptId, shopifyOrderId: input.shopifyOrderId, status: "succeeded", orderAmount: null, orderCurrencyCode: null, attemptedAt: null, completedAt: null, cycleOriginTime: null, reconciliationStatus: "pending", reconciliationAttempts: 1 }, order: any = { id: "order-1", subscriptionId: subscription.id, shopifyOrderId: input.shopifyOrderId, amount: { toString: () => "0" }, currencyCode: null, status: "PAID", processedAt: null }, cycle: any = { id: "cycle-1", subscriptionId: subscription.id, billingCycleAt: new Date(input.cycleOriginTime), status: "pending" }, audits: any[] = [];
  let queue = Promise.resolve();
  const tx: any = {
    shop: { findUnique: async ({ where }: any) => where.domain === shop.domain ? shop : null },
    subscription: { findUnique: async ({ where }: any) => where.shopId_shopifyContractId.shopId === shop.id && where.shopId_shopifyContractId.shopifyContractId === input.subscriptionContractId ? subscription : null },
    subscriptionBillingAttempt: { findMany: async ({ where }: any) => where.shopId === shop.id && where.shopifyBillingAttemptId === attempt.shopifyBillingAttemptId ? [attempt] : [], update: async ({ data }: any) => Object.assign(attempt, data, { reconciliationAttempts: attempt.reconciliationAttempts + 1 }) },
    subscriptionOrder: { findMany: async ({ where }: any) => where.subscriptionId === subscription.id && where.shopifyOrderId === order.shopifyOrderId ? [order] : [], update: async ({ data }: any) => Object.assign(order, data) },
    billingRetryCycle: { findUnique: async () => cycle, update: async ({ data }: any) => Object.assign(cycle, data) },
    billingReconciliationAudit: { findUnique: async ({ where }: any) => audits.find(a => a.billingAttemptId === where.billingAttemptId) ?? null, create: async ({ data }: any) => { if (audits.some(a => a.billingAttemptId === data.billingAttemptId)) throw new Error("duplicate audit"); const value = { id: "audit-1", ...data }; audits.push(value); return value; } },
  };
  const db: any = { $transaction: (callback: any) => { const run = queue.then(() => callback(tx)); queue = run.then(() => undefined, () => undefined); return run; } };
  return { service: new AdministrativeBillingReconciliationService(db), db, tx, shop, attempt, order, cycle, audits };
}

test("dry-run returns before and after with zero writes", async () => { const f = fixture(); const result = await f.service.execute({ ...input, dryRun: true }); assert.equal(result.status, "dry_run"); assert.equal(f.attempt.orderAmount, null); assert.equal(f.audits.length, 0); });
test("first execution updates existing records and creates one audit", async () => { const f = fixture(); const result = await f.service.execute(input); assert.equal(result.status, "reconciled"); assert.equal(f.attempt.orderAmount, "50.19"); assert.equal(f.attempt.orderCurrencyCode, "BRL"); assert.equal(f.attempt.reconciliationStatus, "complete"); assert.equal(f.order.amount, "50.19"); assert.equal(f.cycle.status, "succeeded"); assert.equal(f.audits.length, 1); });
test("identical second execution is already_reconciled with zero duplicate", async () => { const f = fixture(); await f.service.execute(input); const second = await f.service.execute(input); assert.equal(second.status, "already_reconciled"); assert.equal(f.audits.length, 1); assert.equal(f.attempt.reconciliationAttempts, 2); });
test("different payload for same identity conflicts without writes", async () => { const f = fixture(); await f.service.execute(input); await assert.rejects(f.service.execute({ ...input, amount: "51.19" }), (error: any) => error instanceof AdministrativeReconciliationError && error.code === "reconciliation_payload_conflict"); assert.equal(f.order.amount, "50.19"); assert.equal(f.audits.length, 1); });
test("Promise.all has one winner and no duplicate audit", async () => { const f = fixture(); const results = await Promise.all([f.service.execute(input), f.service.execute(input)]); assert.deepEqual(results.map(value => value.status).sort(), ["already_reconciled", "reconciled"]); assert.equal(f.audits.length, 1); });
test("serializable conflict is retried against committed state without duplicate audit", async () => { const f = fixture(); const transaction = f.db.$transaction; let calls = 0; f.db.$transaction = (...args: any[]) => { calls += 1; if (calls === 1) return Promise.reject(new Prisma.PrismaClientKnownRequestError("serialization conflict", { code: "P2034", clientVersion: "test" })); return transaction(...args); }; const result = await f.service.execute(input); assert.equal(result.status, "reconciled"); assert.equal(calls, 2); assert.equal(f.audits.length, 1); });
test("cross-tenant and mismatched identities are rejected before writes", async () => { const f = fixture(); for (const invalid of [{ ...input, shopId: "gid://shopify/Shop/2" }, { ...input, shopDomain: "two.myshopify.com" }, { ...input, shopifyOrderId: "gid://shopify/Order/31" }]) await assert.rejects(f.service.execute(invalid), AdministrativeReconciliationError); assert.equal(f.audits.length, 0); });
test("invalid amount currency test order and gateway fail closed", () => { for (const invalid of [{ ...input, amount: "0" }, { ...input, currencyCode: "" }, { ...input, test: false }, { ...input, gateway: "stripe" }]) assert.throws(() => validateAdministrativeBillingReconciliation(invalid), AdministrativeReconciliationError); });
test("payload rejects secrets and unexpected Shopify credentials", () => { assert.throws(() => validateAdministrativeBillingReconciliation({ ...input, accessToken: "secret" }), AdministrativeReconciliationError); });
test("server-to-server authentication rejects missing and invalid signatures", () => { assert.equal(secureApiKeyMatches(undefined, "expected"), false); assert.equal(secureApiKeyMatches("wrong", "expected"), false); assert.equal(secureApiKeyMatches("expected", "expected"), true); });

test("each reconciliation read reports its exact Prisma stage", async () => {
  const cases = [
    ["shop", "findUnique", "shop_lookup"],
    ["subscription", "findUnique", "subscription_lookup"],
    ["subscriptionBillingAttempt", "findMany", "billing_attempt_lookup"],
    ["subscriptionOrder", "findMany", "subscription_order_lookup"],
    ["billingRetryCycle", "findUnique", "billing_retry_cycle_lookup"],
    ["billingReconciliationAudit", "findUnique", "reconciliation_audit_lookup"],
  ] as const;
  for (const [delegate, operation, expectedStage] of cases) {
    const f = fixture();
    f.tx[delegate][operation] = async () => { throw new Prisma.PrismaClientKnownRequestError("sensitive query failure", { code: "P2022", clientVersion: "6.19.3" }); };
    await assert.rejects(f.service.execute({ ...input, dryRun: true }), (error: unknown) => {
      assert.equal(sanitizedAdministrativeReconciliationPrismaError(error)?.prismaStage, expectedStage);
      return true;
    });
  }
});
