import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { AdministrativeBillingReconciliationController } from "../AdministrativeBillingReconciliationController";
import { recordAdministrativeReconciliationPrismaStage } from "../../shopify/reconciliation/prisma-observability";

function response() {
  const state = { status: 200, body: undefined as unknown };
  return { state, value: { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } } };
}

test("known Prisma failure logs only allowlisted diagnostics and preserves public response", async () => {
  const secretMessage = "DATABASE_URL=postgres://user:password@secret-host/db API_KEY=secret token=secret customer@example.com";
  const error = new Prisma.PrismaClientKnownRequestError(secretMessage, {
    code: "P2022",
    clientVersion: "6.19.3",
    meta: {
      modelName: "SubscriptionBillingAttempt",
      target: ["reconciliationStatus"],
      arbitrary: secretMessage,
      payload: { customer: "customer@example.com" },
    },
  });
  recordAdministrativeReconciliationPrismaStage(error, "billing_attempt_lookup");
  const service = { execute: async () => { throw error; } };
  const calls: unknown[][] = [];
  const controller = new AdministrativeBillingReconciliationController(service as never, { error: (...args: unknown[]) => { calls.push(args); } });
  const output = response();

  await controller.execute({ body: { correlationId: "scope9-safe-correlation", API_KEY: "must-not-log", token: "must-not-log", dryRun: true } } as never, output.value as never);

  assert.equal(output.state.status, 500);
  assert.deepEqual(output.state.body, { error: "administrative_reconciliation_failed" });
  assert.equal(calls.length, 1);
  const logged = calls[0][1] as Record<string, unknown>;
  assert.deepEqual(logged, {
    event: "administrative_reconciliation_failed",
    errorType: "PrismaClientKnownRequestError",
    prismaCode: "P2022",
    prismaStage: "billing_attempt_lookup",
    prismaModelName: "SubscriptionBillingAttempt",
    prismaTarget: ["reconciliationStatus"],
    clientVersion: "6.19.3",
    correlationId: "scope9-safe-correlation",
  });
  const serialized = JSON.stringify(calls);
  for (const blocked of ["DATABASE_URL", "postgres://", "secret-host", "API_KEY", "must-not-log", "token=", "customer@example.com", "arbitrary", "payload", "sensitive query failure", "stack"]) assert.equal(serialized.includes(blocked), false);
});

test("unsafe Prisma metadata is omitted", async () => {
  const error = new Prisma.PrismaClientKnownRequestError("hidden", {
    code: "P2021",
    clientVersion: "unsafe version with spaces",
    meta: { modelName: "unsafe model/value", target: { query: "SELECT secret" } },
  });
  recordAdministrativeReconciliationPrismaStage(error, "reconciliation_audit_lookup");
  const calls: unknown[][] = [];
  const controller = new AdministrativeBillingReconciliationController({ execute: async () => { throw error; } } as never, { error: (...args: unknown[]) => { calls.push(args); } });
  const output = response();
  await controller.execute({ body: { dryRun: true } } as never, output.value as never);
  assert.deepEqual(calls[0][1], {
    event: "administrative_reconciliation_failed",
    errorType: "PrismaClientKnownRequestError",
    prismaCode: "P2021",
    prismaStage: "reconciliation_audit_lookup",
    clientVersion: "unknown",
  });
});

test("non-Prisma failures keep generic logging and response", async () => {
  const calls: unknown[][] = [];
  const controller = new AdministrativeBillingReconciliationController({ execute: async () => { throw new TypeError("hidden"); } } as never, { error: (...args: unknown[]) => { calls.push(args); } });
  const output = response();
  await controller.execute({ body: { dryRun: true } } as never, output.value as never);
  assert.deepEqual(calls[0][1], { errorType: "TypeError" });
  assert.equal(output.state.status, 500);
  assert.deepEqual(output.state.body, { error: "administrative_reconciliation_failed" });
});

test("dry-run route rejects dryRun false and never reaches service", async () => {
  let serviceCalls = 0;
  const controller = new AdministrativeBillingReconciliationController({ execute: async () => { serviceCalls += 1; return { status: "reconciled" }; } } as never, { error: () => {} });
  const output = response();
  await controller.execute({ body: { dryRun: false } } as never, output.value as never);
  assert.equal(output.state.status, 400);
  assert.deepEqual(output.state.body, { error: "dry_run_required" });
  assert.equal(serviceCalls, 0);
});

test("live route requires and preserves explicit dryRun false", async () => {
  const received: unknown[] = [];
  const controller = new AdministrativeBillingReconciliationController({ execute: async (input: unknown) => { received.push(input); return { status: "reconciled" }; } } as never, { error: () => {} });
  const output = response();
  await controller.executeLive({ body: { shopDomain: "one.myshopify.com", correlationId: "scope9-live", dryRun: false } } as never, output.value as never);
  assert.equal(output.state.status, 200);
  assert.equal(received.length, 1);
  const input = received[0] as any;
  assert.equal(input.dryRun, false);
  assert.equal(input.shopDomain, "one.myshopify.com");
  assert.equal(input.correlationId, "scope9-live");
});

test("live route rejects missing or true dryRun and never reaches service", async () => {
  let serviceCalls = 0;
  const controller = new AdministrativeBillingReconciliationController({ execute: async () => { serviceCalls += 1; return {}; } } as never, { error: () => {} });
  for (const body of [{}, { dryRun: true }]) {
    const output = response();
    await controller.executeLive({ body } as never, output.value as never);
    assert.equal(output.state.status, 400);
    assert.deepEqual(output.state.body, { error: "live_mode_required" });
  }
  assert.equal(serviceCalls, 0);
});
