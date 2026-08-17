import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import { reconciliationForStripeEvent, safeStripePatch, StripeEventProcessor } from "../StripeEventProcessor";

function event(type: Stripe.Event.Type, created: number, object: Record<string, unknown>, id = `evt_${type}_${created}`) { return { id, type, created, data: { object } } as unknown as Stripe.Event; }
function state(overrides: Record<string, unknown> = {}) { return { id: "aps-1", shopId: "shop-1", status: "active", lastPaymentStatus: null as string | null, lastGatewayStatusEventAt: null as Date | null, lastGatewayPaymentEventAt: null as Date | null, ...overrides }; }
function apply(current: ReturnType<typeof state>, value: Stripe.Event) { Object.assign(current, safeStripePatch(current as never, value, reconciliationForStripeEvent(value)!)); }

test("new succeeded followed by old failed preserves succeeded", () => { const current = state(); apply(current, event("invoice.payment_succeeded", 200, { id: "in_new", subscription: "sub_1" })); apply(current, event("invoice.payment_failed", 100, { id: "in_old", subscription: "sub_1" })); assert.equal(current.lastPaymentStatus, "succeeded"); assert.equal(current.lastGatewayPaymentEventAt?.getTime(), 200_000); });
test("new failed followed by old succeeded preserves failed", () => { const current = state(); apply(current, event("invoice.payment_failed", 200, { id: "in_new", subscription: "sub_1" })); apply(current, event("invoice.payment_succeeded", 100, { id: "in_old", subscription: "sub_1" })); assert.equal(current.lastPaymentStatus, "failed"); assert.equal(current.lastGatewayPaymentEventAt?.getTime(), 200_000); });
test("status and invoice ordering clocks are independent", () => { const current = state({ status: "paused" }); apply(current, event("customer.subscription.updated", 300, { id: "sub_1", status: "active" })); apply(current, event("invoice.payment_failed", 100, { id: "in_1", subscription: "sub_1" })); apply(current, event("customer.subscription.updated", 400, { id: "sub_1", status: "active", pause_collection: { behavior: "void" } })); assert.equal(current.status, "paused"); assert.equal(current.lastPaymentStatus, "failed"); assert.equal(current.lastGatewayStatusEventAt?.getTime(), 400_000); assert.equal(current.lastGatewayPaymentEventAt?.getTime(), 100_000); });
test("events with the same timestamp do not overwrite the first result", () => { const current = state(); apply(current, event("invoice.payment_succeeded", 200, { id: "in_1", subscription: "sub_1" })); apply(current, event("invoice.payment_failed", 200, { id: "in_2", subscription: "sub_1" })); assert.equal(current.lastPaymentStatus, "succeeded"); });
test("terminal Stripe subscription rejects older paused and active events", () => { for (const status of ["cancelled", "expired", "failed"]) for (const incoming of [{ status: "active" }, { status: "active", pause_collection: { behavior: "void" } }]) { const current = state({ status, lastGatewayStatusEventAt: new Date(2_000 * 1000) }); const value = event("customer.subscription.updated", 1_000, { id: "sub_1", ...incoming }); assert.equal("status" in safeStripePatch(current as never, value, reconciliationForStripeEvent(value)!), false); } });

test("repeated Stripe event is processed once", async () => {
  const events = new Map<string, { processed: boolean }>(); let updates = 0;
  const subscription = { ...state(), externalId: "sub_1", gateway: "stripe" };
  const prisma: any = {
    subscription: { findFirst: async () => subscription, update: async ({ data }: any) => { updates += 1; Object.assign(subscription, data); } },
    webhookEvent: { findUnique: async ({ where }: any) => events.get(where.eventId) || null, create: async ({ data }: any) => { events.set(data.eventId, { processed: false }); }, update: async ({ where }: any) => { events.set(where.eventId, { processed: true }); } },
    subscriptionOrder: { findFirst: async () => null, create: async () => ({}) },
    subscriptionStatusHistory: { upsert: async () => ({}) },
    $transaction: async (callback: any) => callback(prisma),
  };
  const processor = new StripeEventProcessor(prisma);
  const value = event("customer.subscription.updated", 100, { id: "sub_1", status: "active" }, "evt_repeat");
  assert.equal((await processor.process(value)).duplicate, false);
  assert.equal((await processor.process(value)).duplicate, true);
  assert.equal(updates, 1);
});
