import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBillingSourceKey } from "../billing-notification-identity";

const contractId = "gid://shopify/SubscriptionContract/42";
const attemptId = "gid://shopify/SubscriptionBillingAttempt/99";
const idempotencyKey = "aps:shop-1:cycle-1:payment:0";
const billingCycleAt = "2026-08-24T12:00:00-03:00";

test("retry success and webhook success use billingAttemptId when both identities exist", () => {
  const retry = canonicalBillingSourceKey({ shopifyBillingAttemptId: attemptId, idempotencyKey, shopifyContractId: contractId, billingCycleAt });
  const webhook = canonicalBillingSourceKey({ shopifyBillingAttemptId: attemptId, idempotencyKey, shopifyContractId: contractId, billingCycleAt: new Date(billingCycleAt) });
  assert.equal(retry, webhook);
  assert.equal(retry, `billing-attempt:${attemptId}`);
});

test("retry failure, webhook failure, redelivery and out-of-order delivery keep one canonical identity", () => {
  const inputs = [
    { shopifyBillingAttemptId: attemptId, idempotencyKey, shopifyContractId: contractId, billingCycleAt },
    { shopifyBillingAttemptId: attemptId, idempotencyKey, shopifyContractId: contractId, billingCycleAt: "2026-08-25T00:00:00Z" },
    { shopifyBillingAttemptId: attemptId, shopifyContractId: contractId, billingCycleAt },
  ];
  assert.equal(new Set(inputs.map(canonicalBillingSourceKey)).size, 1);
});

test("billing identity falls back to persisted idempotency key", () => {
  assert.equal(canonicalBillingSourceKey({ idempotencyKey, shopifyContractId: contractId, billingCycleAt }), `billing-idempotency:${idempotencyKey}`);
});

test("billing identity falls back to contract and normalized billing cycle", () => {
  assert.equal(canonicalBillingSourceKey({ shopifyContractId: contractId, billingCycleAt }), `billing-cycle:${contractId}:2026-08-24T15:00:00.000Z`);
});

test("canonical billing identity yields one event and one delivery key for duplicate success and failure", () => {
  for (const eventType of ["renewal_succeeded", "payment_failed"]) {
    const sourceKeys = [
      canonicalBillingSourceKey({ shopifyBillingAttemptId: attemptId, idempotencyKey }),
      canonicalBillingSourceKey({ shopifyBillingAttemptId: attemptId, idempotencyKey }),
    ];
    const eventKeys = sourceKeys.map(source => `event:shop-1:${eventType}:${source}`);
    const deliveryKeys = sourceKeys.map(source => `customer:shop-1:${eventType}:${source}:customer@example.com`);
    assert.equal(new Set(eventKeys).size, 1);
    assert.equal(new Set(deliveryKeys).size, 1);
  }
});
