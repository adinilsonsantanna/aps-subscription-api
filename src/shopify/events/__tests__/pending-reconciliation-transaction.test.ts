import assert from "node:assert/strict";
import test from "node:test";
import { PrismaShopifyEventRepository } from "../shopify-event.repository";
import { ShopifyBillingReconciliationPendingError } from "../shopify-event.types";

function fixture() {
  const operations: string[] = [], attempts: any[] = [], orders: any[] = [];
  const webhook = { eventId: "delivery-1", processed: false, processedAt: null as Date | null, errorMessage: null as string | null };
  const subscription = { id: "sub-1", status: "active", shopifyCustomerEmail: null };
  const tx: any = {
    shop: { findUnique: async () => ({ shopifyShopId: "gid://shopify/Shop/1" }) },
    subscription: { upsert: async () => subscription, update: async () => subscription, findUnique: async () => subscription },
    subscriptionBillingAttempt: {
      findFirst: async ({ where }: any) => attempts.find(a => where.OR.some((candidate: any) => candidate.shopifyBillingAttemptId === a.shopifyBillingAttemptId || candidate.idempotencyKey === a.idempotencyKey || candidate.webhookEventId === a.webhookEventId)) ?? null,
      create: async ({ data }: any) => { const value = { id: "attempt-1", ...data }; attempts.push(value); return value; },
      update: async ({ data }: any) => { Object.assign(attempts[0], data, { reconciliationAttempts: attempts[0].reconciliationAttempts + 1 }); return attempts[0]; },
    },
    subscriptionOrder: { upsert: async ({ create, update }: any) => { if (orders[0]) return Object.assign(orders[0], update); const value = { id: "order-1", ...create }; orders.push(value); return value; } },
    billingRetryCycle: { upsert: async () => ({ id: "cycle-1", status: "succeeded" }) },
    subscriptionStatusHistory: { upsert: async () => ({}) },
    webhookEvent: { update: async ({ data }: any) => { operations.push("event-complete"); Object.assign(webhook, data); return webhook; } },
  };
  const db: any = { $transaction: async (callback: any) => { operations.push("begin"); const result = await callback(tx); operations.push("commit"); return result; }, subscription: { findUnique: async () => subscription } };
  return { repository: new PrismaShopifyEventRepository(db, { emit: async () => ({}) } as never), attempts, orders, webhook, operations };
}
const pending: any = { shop: "one.myshopify.com", shopifyShopId: "gid://shopify/Shop/1", topic: "subscription_billing_attempts/success", webhookId: "delivery-1", payload: { admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/20", admin_graphql_api_subscription_contract_id: "gid://shopify/SubscriptionContract/10", idempotency_key: "cycle-key" }, receivedAt: new Date("2026-08-28T12:00:02Z"), billingAttempt: { id: "gid://shopify/SubscriptionBillingAttempt/20", idempotencyKey: "cycle-key", contractId: "gid://shopify/SubscriptionContract/10", state: "succeeded", reconciliationStatus: "pending" } };
const complete: any = { ...pending, triggeredAt: new Date("2026-08-28T12:00:02Z"), billingAttempt: { ...pending.billingAttempt, cycleOriginTime: "2026-09-27T16:00:00Z", completedAt: "2026-08-28T12:00:01Z", reconciliationStatus: "complete", order: { id: "gid://shopify/Order/30", test: true, financialStatus: "PAID", amount: "50.19", currencyCode: "BRL", shipping: "41.19" } } };

test("pending commits before typed retryable error and event remains incomplete", async () => { const f = fixture(); await assert.rejects(f.repository.processEvent(pending, "shop-1"), ShopifyBillingReconciliationPendingError); assert.deepEqual(f.operations, ["begin", "commit"]); assert.equal(f.attempts.length, 1); assert.equal(f.attempts[0].reconciliationStatus, "pending"); assert.equal(f.attempts[0].reconciliationAttempts, 1); assert.equal(f.attempts[0].orderAmount, undefined); assert.equal(f.attempts[0].attemptedAt, undefined); assert.equal(f.webhook.processed, false); });
test("retry completes the same attempt and creates one real order", async () => { const f = fixture(); await assert.rejects(f.repository.processEvent(pending, "shop-1"), ShopifyBillingReconciliationPendingError); await f.repository.processEvent(complete, "shop-1"); assert.equal(f.attempts.length, 1); assert.equal(f.attempts[0].reconciliationAttempts, 2); assert.equal(f.attempts[0].reconciliationStatus, "complete"); assert.equal(f.attempts[0].orderAmount, "50.19"); assert.equal(f.orders.length, 1); assert.equal(f.orders[0].amount, "50.19"); assert.equal(f.webhook.processed, true); });
