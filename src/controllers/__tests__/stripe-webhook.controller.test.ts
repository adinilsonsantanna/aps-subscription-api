import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { StripeWebhookController } from "../StripeWebhookController";

function response() { const state = { status: 200, body: undefined as unknown }; return { state, value: { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } } }; }
function request(signature?: string, body: unknown = Buffer.from("{}")) { return { body, header: (name: string) => name === "stripe-signature" ? signature : undefined }; }

test("Express Stripe webhook rejects missing and invalid signatures with 400", async () => {
  for (const verifier of [{ constructEvent: () => { throw new Error("invalid signature"); } }, { constructEvent: () => ({}) }]) {
    const processor = { process: async () => { throw new Error("must not process"); } };
    const controller = new StripeWebhookController(verifier as never, processor as never);
    const output = response();
    await controller.handle(request(verifier.constructEvent.toString().includes("throw") ? "bad" : undefined) as never, output.value as never);
    assert.equal(output.state.status, 400);
  }
});

test("Express Stripe webhook processes only the verified Stripe.Event", async () => {
  const verified = { id: "evt_verified", type: "customer.subscription.updated", created: 1, data: { object: { id: "sub_1" } } } as Stripe.Event;
  let received: Stripe.Event | undefined;
  const controller = new StripeWebhookController({ constructEvent: () => verified } as never, { process: async (event: Stripe.Event) => { received = event; return { processed: true }; } } as never);
  const output = response();
  await controller.handle(request("valid") as never, output.value as never);
  assert.equal(output.state.status, 200);
  assert.equal(received, verified);
});
