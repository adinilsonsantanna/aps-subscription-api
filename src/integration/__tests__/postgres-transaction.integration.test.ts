import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  AdministrativeBillingReconciliationService,
  AdministrativeReconciliationError,
} from "../../shopify/reconciliation/admin-billing-reconciliation";
import { assertSafePostgresTestDatabaseUrl } from "../postgres-test-database-guard";

const url = process.env.TEST_DATABASE_URL
  ? assertSafePostgresTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL)
  : undefined;
const live = url ? test : test.skip;

live("real administrative reconciliation service rolls back failures and serializes concurrent requests", async () => {
  assert.ok(url);
  const db = new PrismaClient({ datasourceUrl: url });
  const stamp = `${process.pid}${Date.now()}`;
  const createdShopIds: string[] = [];

  type FailureStage = "order" | "audit";
  const service = (failureStage?: FailureStage) => new AdministrativeBillingReconciliationService({
    $transaction: (callback: (tx: unknown) => Promise<unknown>, options: unknown) => db.$transaction(async (tx) => {
      const wrapped = new Proxy(tx as any, {
        get(target, property, receiver) {
          if (failureStage === "order" && property === "subscriptionOrder") {
            return new Proxy(target.subscriptionOrder, {
              get(delegate, operation, delegateReceiver) {
                if (operation === "update") return async () => { throw new Error("forced_order_update_failure"); };
                return Reflect.get(delegate, operation, delegateReceiver);
              },
            });
          }
          if (failureStage === "audit" && property === "billingReconciliationAudit") {
            return new Proxy(target.billingReconciliationAudit, {
              get(delegate, operation, delegateReceiver) {
                if (operation === "create") return async () => { throw new Error("forced_audit_create_failure"); };
                return Reflect.get(delegate, operation, delegateReceiver);
              },
            });
          }
          return Reflect.get(target, property, receiver);
        },
      });
      return callback(wrapped);
    }, options as any),
  } as any);

  async function fixture(label: string) {
    const suffix = `${stamp}${label.charCodeAt(0)}`;
    const shopifyShopId = `gid://shopify/Shop/${suffix}`;
    const subscriptionContractId = `gid://shopify/SubscriptionContract/${suffix}`;
    const subscriptionBillingAttemptId = `gid://shopify/SubscriptionBillingAttempt/${suffix}`;
    const shopifyOrderId = `gid://shopify/Order/${suffix}`;
    const shop = await db.shop.create({ data: { name: `Harness ${label}`, domain: `scope9-${label}-${stamp}.myshopify.com`, accessToken: "test-only", scopes: "", shopifyShopId } });
    createdShopIds.push(shop.id);
    const subscription = await db.subscription.create({ data: { shopId: shop.id, shopifyContractId: subscriptionContractId } });
    const attempt = await db.subscriptionBillingAttempt.create({ data: { shopId: shop.id, subscriptionId: subscription.id, shopifyContractId: subscriptionContractId, shopifyBillingAttemptId: subscriptionBillingAttemptId, shopifyOrderId, status: "succeeded", reconciliationStatus: "pending" } });
    const order = await db.subscriptionOrder.create({ data: { subscriptionId: subscription.id, shopifyOrderId, amount: "0", status: "PAID" } });
    const input = {
      shopDomain: shop.domain, shopId: shopifyShopId, subscriptionContractId,
      subscriptionBillingAttemptId, shopifyOrderId, cycleOriginTime: "2026-09-27T16:00:00.000Z",
      status: "succeeded", amount: "50.19", currencyCode: "BRL",
      attemptedAt: "2026-08-27T17:28:45Z", completedAt: "2026-08-27T17:28:45Z",
      orderProcessedAt: "2026-08-27T17:28:51.161Z", test: true, gateway: "bogus",
      correlationId: `scope9-real-${label}-${stamp}`, dryRun: false,
    } as const;
    return { shop, subscription, attempt, order, input };
  }

  async function state(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      attempt: await db.subscriptionBillingAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } }),
      order: await db.subscriptionOrder.findUniqueOrThrow({ where: { id: f.order.id } }),
      orderCount: await db.subscriptionOrder.count({ where: { subscriptionId: f.subscription.id, shopifyOrderId: f.input.shopifyOrderId } }),
      auditCount: await db.billingReconciliationAudit.count({ where: { billingAttemptId: f.attempt.id } }),
    };
  }

  try {
    const happy = await fixture("happy");
    assert.equal((await service().execute(happy.input)).status, "reconciled");
    let after = await state(happy);
    assert.equal(after.attempt.reconciliationStatus, "complete");
    assert.equal(after.order.amount.toString(), "50.19");
    assert.equal(after.orderCount, 1);
    assert.equal(after.auditCount, 1);

    const orderFailure = await fixture("order");
    await assert.rejects(service("order").execute(orderFailure.input), /forced_order_update_failure/);
    after = await state(orderFailure);
    assert.equal(after.attempt.reconciliationStatus, "pending");
    assert.equal(after.attempt.orderAmount, null);
    assert.equal(after.order.amount.toString(), "0");
    assert.equal(after.auditCount, 0);

    const auditFailure = await fixture("audit");
    await assert.rejects(service("audit").execute(auditFailure.input), /forced_audit_create_failure/);
    after = await state(auditFailure);
    assert.equal(after.attempt.reconciliationStatus, "pending");
    assert.equal(after.attempt.orderAmount, null);
    assert.equal(after.order.amount.toString(), "0");
    assert.equal(after.auditCount, 0);

    const concurrent = await fixture("concurrent");
    const results = await Promise.all([service().execute(concurrent.input), service().execute(concurrent.input)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["already_reconciled", "reconciled"]);
    after = await state(concurrent);
    assert.equal(after.attempt.reconciliationStatus, "complete");
    assert.equal(after.order.amount.toString(), "50.19");
    assert.equal(after.orderCount, 1);
    assert.equal(after.auditCount, 1);

    await assert.rejects(service().execute({ ...concurrent.input, amount: "51.19" }), (error: unknown) => error instanceof AdministrativeReconciliationError && error.code === "reconciliation_payload_conflict");
    after = await state(concurrent);
    assert.equal(after.order.amount.toString(), "50.19");
    assert.equal(after.auditCount, 1);

    const otherShop = await fixture("tenant");
    await assert.rejects(service().execute({ ...concurrent.input, shopDomain: otherShop.shop.domain }), (error: unknown) => error instanceof AdministrativeReconciliationError && error.code === "shop_identity_mismatch");
    assert.equal((await state(otherShop)).auditCount, 0);
    assert.equal((await state(concurrent)).auditCount, 1);
  } finally {
    await db.shop.deleteMany({ where: { id: { in: createdShopIds } } });
    await db.$disconnect();
  }
});
