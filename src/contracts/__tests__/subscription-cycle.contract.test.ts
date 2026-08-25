import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_HTTP_STATUSES, RETRY_OPERATIONS, SUBSCRIPTION_CYCLE_CONTRACT_VERSION, validateContractStatus, validateRetryRequest, validateRetryResponse } from "../subscription-cycle.v1";

test("canonical v1 contract validates request response enums required optional fields and status families", () => {
  assert.equal(SUBSCRIPTION_CYCLE_CONTRACT_VERSION, "aps.subscription-cycle.v1");
  assert.deepEqual(RETRY_OPERATIONS, ["inventory", "charge", "reconcile"]);
  const request = { shop: "one.myshopify.com", contractId: "gid://shopify/SubscriptionContract/1", operation: "charge", idempotencyKey: "scope9:1", billingCycleAt: "2026-08-31T12:00:00.000Z" };
  const response = { success: true, uncertain: false, errorCode: null, errorMessage: null, billingAttemptId: "gid://shopify/SubscriptionBillingAttempt/1", orderId: "gid://shopify/Order/1", amount: "10.00", currencyCode: "BRL", status: "succeeded" };
  assert.equal(validateRetryRequest(request), true);
  assert.equal(validateRetryRequest({ ...request, contractId: undefined }), false);
  assert.equal(validateRetryRequest({ ...request, operation: "delete" }), false);
  assert.equal(validateRetryResponse(response), true);
  assert.equal(validateRetryResponse({ ...response, uncertain: undefined }), false);
  for (const status of [400, 401, 409, 429, 500, 502, 503, 504]) assert.equal(validateContractStatus(status), true);
  assert.equal(validateContractStatus(418), false);
  assert.ok(CONTRACT_HTTP_STATUSES.includes(200));
});
