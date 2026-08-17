import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { reconciliationForStripeEvent, safeStripePatch } from "../StripeEventProcessor";

function event(type: Stripe.Event.Type, created: number, object: Record<string, unknown>) { return { id: `evt_${type}_${created}`, type, created, data: { object } } as unknown as Stripe.Event; }

test("terminal Stripe subscription rejects older paused and active events", () => {
  const lastGatewayEventAt = new Date(2_000 * 1000);
  for (const status of ["cancelled", "expired", "failed"]) for (const incoming of [{ status: "active" }, { status: "active", pause_collection: { behavior: "void" } }]) {
    const value = event("customer.subscription.updated", 1_000, { id: "sub_1", ...incoming });
    const reconciliation = reconciliationForStripeEvent(value)!;
    assert.equal("status" in safeStripePatch({ status, lastGatewayEventAt } as never, value, reconciliation), false);
  }
});

test("Stripe event.created prevents an older non-terminal update", () => { const value = event("customer.subscription.updated", 1_000, { id: "sub_1", status: "active" }); const patch = safeStripePatch({ status: "paused", lastGatewayEventAt: new Date(2_000 * 1000) } as never, value, reconciliationForStripeEvent(value)!); assert.equal("status" in patch, false); });
test("Stripe subscription lookup reconciliation keeps the external subscription ID", () => { const value = event("invoice.payment_failed", 1_000, { id: "in_1", subscription: "sub_1" }); assert.deepEqual(reconciliationForStripeEvent(value), { externalId: "sub_1", invoiceId: "in_1", paymentStatus: "failed" }); });
