import assert from "node:assert/strict";
import test from "node:test";
import { ShopifyEventValidationError, validateIncomingShopifyEvent } from "../shopify-event.types";
import { reconciledBillingAttemptData } from "../shopify-event.repository";

const body = {
  shop: "aps-test-store-hx3rwtgw.myshopify.com", shopifyShopId: "gid://shopify/Shop/100264018283",
  topic: "subscription_billing_attempts/success", webhookId: "delivery-1", receivedAt: "2026-08-28T12:00:02.000Z", triggeredAt: "2026-08-28T12:00:02.000Z",
  payload: { admin_graphql_api_subscription_contract_id: "gid://shopify/SubscriptionContract/166901350763" },
  billingAttempt: {
    id: "gid://shopify/SubscriptionBillingAttempt/1", idempotencyKey: "scope9-cycle-1", cycleOriginTime: "2026-09-27T16:00:00.000Z",
    createdAt: "2026-08-28T12:00:00.000Z", completedAt: "2026-08-28T12:00:01.000Z", state: "succeeded",
    contractId: "gid://shopify/SubscriptionContract/166901350763", nextBillingAt: "2026-10-27T16:00:00.000Z",
    order: { id: "gid://shopify/Order/2", processedAt: "2026-08-28T12:00:01.000Z", test: true, financialStatus: "PAID", amount: "50.19", currencyCode: "BRL", subtotal: "9.00", shipping: "41.19", tax: "0.00" },
    reconciliationStatus: "complete",
  },
} as const;

test("accepts the exact Shopify order total and keeps origin, completion and delivery timestamps separate", () => {
  const event = validateIncomingShopifyEvent(body);
  assert.equal(event.billingAttempt?.order?.amount, "50.19");
  assert.equal(event.billingAttempt?.order?.shipping, "41.19");
  assert.equal(event.billingAttempt?.cycleOriginTime, "2026-09-27T16:00:00.000Z");
  assert.equal(event.billingAttempt?.completedAt, "2026-08-28T12:00:01.000Z");
  assert.equal(event.triggeredAt?.toISOString(), "2026-08-28T12:00:02.000Z");
});

test("rejects a completed success without real order money instead of persisting zero", () => {
  const invalid = structuredClone(body) as any; delete invalid.billingAttempt.order;
  assert.throws(() => validateIncomingShopifyEvent(invalid), ShopifyEventValidationError);
});

test("allows a pending reconciliation without inventing amount or attemptedAt", () => {
  const pending = structuredClone(body) as any; pending.billingAttempt.reconciliationStatus = "pending"; delete pending.billingAttempt.order; delete pending.billingAttempt.completedAt; delete pending.triggeredAt;
  const event = validateIncomingShopifyEvent(pending);
  assert.equal(event.billingAttempt?.reconciliationStatus, "pending");
  assert.equal(event.billingAttempt?.order, undefined);
  assert.equal(event.triggeredAt, undefined);
});

test("persistence data uses completedAt as attemptedAt and never cycle origin or receivedAt", () => {
  const event = validateIncomingShopifyEvent(body);
  const data = reconciledBillingAttemptData(event);
  assert.equal(data.attemptedAt?.toISOString(), "2026-08-28T12:00:01.000Z");
  assert.equal(data.cycleOriginTime?.toISOString(), "2026-09-27T16:00:00.000Z");
  assert.equal(data.orderAmount, "50.19");
  assert.equal(data.orderCurrencyCode, "BRL");
});

test("pending persistence has no zero amount and no invented attemptedAt", () => {
  const pending = structuredClone(body) as any; pending.billingAttempt.reconciliationStatus = "pending"; delete pending.billingAttempt.order; delete pending.billingAttempt.completedAt; delete pending.triggeredAt;
  const data = reconciledBillingAttemptData(validateIncomingShopifyEvent(pending));
  assert.equal(data.orderAmount, undefined);
  assert.equal(data.attemptedAt, undefined);
  assert.equal(data.reconciliationStatus, "pending");
});
