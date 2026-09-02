import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { AdministrativeBillingReconciliationController } from "../../../controllers/AdministrativeBillingReconciliationController";
import { keysFingerprint } from "../keys-fingerprint";

const validBody = {
  shopDomain: "one.myshopify.com", shopId: "gid://shopify/Shop/1", subscriptionContractId: "gid://shopify/SubscriptionContract/10", subscriptionBillingAttemptId: "gid://shopify/SubscriptionBillingAttempt/20", shopifyOrderId: "gid://shopify/Order/30", cycleOriginTime: "2026-09-27T16:00:00.000Z", status: "succeeded", amount: "50.19", currencyCode: "BRL", attemptedAt: "2026-08-27T17:28:45Z", completedAt: "2026-08-27T17:28:45Z", orderProcessedAt: "2026-08-27T17:28:51.161Z", test: true, gateway: "bogus", correlationId: "scope9-live-cycle", dryRun: false,
};

function responseMock() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { state.status = code; return res; },
    json(body: unknown) { state.body = body; return res; },
  } as unknown as Response;
  return { res, state };
}

test("live unexpected_field loga nomes das chaves, fingerprint e requestId sem expor valores", async () => {
  const logs: unknown[] = [];
  const controller = new AdministrativeBillingReconciliationController(undefined as never, { error: (...args: unknown[]) => { logs.push(args); } } as Pick<Console, "error">);
  const req = { body: { ...validBody, pwned: "segredo" } } as unknown as Request;
  const { res, state } = responseMock();
  await controller.executeLive(req, res);

  assert.equal(state.status, 400);
  const responseBody = state.body as { error: string; requestId?: string };
  assert.equal(responseBody.error, "unexpected_field");
  assert.equal(typeof responseBody.requestId, "string");

  const entry = JSON.stringify(logs[0]);
  const logObject = (logs[0] as unknown[])[1] as Record<string, unknown>;
  assert.ok(entry.includes("administrative_reconciliation_live_unexpected_field"));
  assert.deepEqual(logObject.unknownKeys, ["pwned"]);
  assert.equal(logObject.keyCount, 17);
  assert.equal(logObject.fingerprint, keysFingerprint(req.body));
  assert.equal(logObject.requestId, responseBody.requestId);
  assert.equal(logObject.correlationId, validBody.correlationId);
  assert.ok(!entry.includes("segredo"));
  assert.ok(!entry.includes("accessToken"));
  assert.ok(!JSON.stringify(logObject).includes("one.myshopify.com"));
});

test("live unexpected_field jamais expõe headers, api key ou valor do campo no log", async () => {
  const logs: unknown[] = [];
  const controller = new AdministrativeBillingReconciliationController(undefined as never, { error: (...args: unknown[]) => { logs.push(args); } } as Pick<Console, "error">);
  const req = { body: { ...validBody, confirmationMessage: "confirmar" } } as unknown as Request;
  const { res } = responseMock();
  await controller.executeLive(req, res);
  const entry = JSON.stringify(logs[0]);
  assert.ok(entry.includes("confirmationMessage"));
  assert.ok(!entry.includes("confirmar"));
  assert.ok(!JSON.stringify(logs[0]).includes("x-api-key"));
  assert.ok(!JSON.stringify(logs[0]).includes("x-admin-live-key"));
});