import assert from "node:assert/strict";
import test from "node:test";
import { SubscriptionController } from "../SubscriptionController";

test("legacy DELETE compatibility delegates cancel to the idempotent lifecycle flow", async () => {
  let received: unknown[] = [];
  const lifecycle = { execute: async (...args: unknown[]) => { received = args; return { success: true, status: "cancelled" }; } };
  const controller = new SubscriptionController(lifecycle as never);
  const request = { params: { id: "aps-1" }, body: {}, header: (name: string) => name === "Idempotency-Key" ? "delete-key" : undefined };
  const state = { status: 0, body: undefined as unknown };
  const response = { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } };
  await controller.cancelCompatibility(request as never, response as never);
  assert.deepEqual(received, ["aps-1", "cancel", "delete-key", "CUSTOMER"]);
  assert.equal(state.status, 200);
});
