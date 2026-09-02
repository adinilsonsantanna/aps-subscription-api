import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { AdministrativeBillingReconciliationController } from "../../../controllers/AdministrativeBillingReconciliationController";
import { keysFingerprint, INVALID_KEY_NAME_MARKER, MAX_LOGGED_UNEXPECTED_KEYS } from "../keys-fingerprint";

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
  assert.deepEqual(logObject.unknownKeys, [INVALID_KEY_NAME_MARKER]);
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

test("live unexpected_field sanitiza nome de chave inválida e mantém resposta pública", async () => {
  const logs: unknown[] = [];
  const controller = new AdministrativeBillingReconciliationController(undefined as never, { error: (...args: unknown[]) => { logs.push(args); } } as Pick<Console, "error">);
  const req = { body: { ...validBody, "apiKey\nsecret-token": "shhh" } } as unknown as Request;
  const { res, state } = responseMock();
  await controller.executeLive(req, res);
  assert.equal(state.status, 400);
  assert.equal((state.body as { error: string }).error, "unexpected_field");
  const logObject = (logs[0] as unknown[])[1] as Record<string, unknown>;
  assert.deepEqual(logObject.unknownKeys, [INVALID_KEY_NAME_MARKER]);
  assert.equal(logObject.keyCount, 17);
  assert.equal(logObject.fingerprint, keysFingerprint(req.body));
  const serialized = JSON.stringify(logs[0]);
  assert.ok(!serialized.includes("apiKey"));
  assert.ok(!serialized.includes("secret-token"));
  assert.ok(!serialized.includes("shhh"));
  assert.ok(!serialized.includes("\n"));
});

test("live unexpected_field com muitas chaves limita log mas mantém keyCount e fingerprint completos", async () => {
  const logs: unknown[] = [];
  const controller = new AdministrativeBillingReconciliationController(undefined as never, { error: (...args: unknown[]) => { logs.push(args); } } as Pick<Console, "error">);
  const extra: Record<string, number> = {};
  for (let i = 0; i < 30; i += 1) extra[`extra_${i}`] = i;
  const body = { ...validBody, ...extra };
  const req = { body } as unknown as Request;
  const { res, state } = responseMock();
  await controller.executeLive(req, res);
  assert.equal(state.status, 400);
  assert.equal((state.body as { error: string }).error, "unexpected_field");
  const logObject = (logs[0] as unknown[])[1] as Record<string, unknown>;
  assert.equal((logObject.unknownKeys as string[]).length, MAX_LOGGED_UNEXPECTED_KEYS);
  assert.equal((logObject.unknownKeys as string[]).length, 20);
  assert.equal(logObject.keyCount, 46);
  assert.equal(logObject.fingerprint, keysFingerprint(body));
});