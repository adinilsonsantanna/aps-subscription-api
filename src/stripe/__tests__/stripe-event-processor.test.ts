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
    subscriptionOrder: { findFirst: async () => null, create: async () => ({}), update: async () => ({}) },
    subscriptionStatusHistory: { upsert: async () => ({}) },
    $transaction: async (callback: any) => callback(prisma),
  };
  const processor = new StripeEventProcessor(prisma);
  const value = event("customer.subscription.updated", 100, { id: "sub_1", status: "active" }, "evt_repeat");
  assert.equal((await processor.process(value)).duplicate, false);
  assert.equal((await processor.process(value)).duplicate, true);
  assert.equal(updates, 1);
});

function invoiceEvent(type: "invoice.payment_succeeded" | "invoice.payment_failed" | "invoice.payment_action_required", id: string, overrides: Record<string, unknown> = {}) {
  return event(type, 500, { id, subscription: "sub_historical", amount_paid: type === "invoice.payment_succeeded" ? 12990 : 0, currency: "brl", billing_reason: "subscription_cycle", lines: { data: [{ period: { end: 900 } }] }, ...overrides }, `evt_${id}_${type}`);
}

function processorContext(gateway = "stripe") {
  const events = new Map<string, { processed: boolean }>();
  const orders: any[] = [];
  const subscription: any = { ...state(), gateway, externalId: "sub_historical", stripeCustomerId: "cus_historical", stripePaymentMethodId: "pm_historical", shopifyVariantId: "123", nextBillingAt: null, shop: { domain: "known.myshopify.com" } };
  let shopifyCalls = 0;
  let failShopify = false;
  const prisma: any = {
    subscription: {
      findFirst: async ({ where }: any) => where.gateway === subscription.gateway && where.externalId === subscription.externalId ? subscription : null,
      update: async ({ data }: any) => { Object.assign(subscription, data); return subscription; },
    },
    webhookEvent: {
      findUnique: async ({ where }: any) => events.get(where.eventId) || null,
      create: async ({ data }: any) => { events.set(data.eventId, { processed: false }); },
      update: async ({ where, data }: any) => { events.set(where.eventId, { processed: data.processed }); },
    },
    subscriptionOrder: {
      findFirst: async ({ where }: any) => orders.find((order) => order.gatewayOrderId === where.gatewayOrderId && order.subscriptionId === where.subscriptionId) || null,
      create: async ({ data }: any) => { const order = { id: `order-${orders.length + 1}`, ...data }; orders.push(order); return order; },
      update: async ({ where, data }: any) => { const order = orders.find((candidate) => candidate.id === where.id); Object.assign(order, data); return order; },
    },
    subscriptionStatusHistory: { upsert: async () => ({}) },
    $transaction: async (callback: any) => callback(prisma),
  };
  const recurring = { create: async () => { shopifyCalls += 1; if (failShopify) throw new Error("shopify unavailable"); return "gid://shopify/Order/999"; } };
  return { processor: new StripeEventProcessor(prisma, recurring), subscription, orders, events, shopifyCalls: () => shopifyCalls, failShopify: () => { failShopify = true; } };
}

test("succeeded stores the real amount, currency, payment status and next billing date", async () => {
  process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW = "false";
  const context = processorContext();
  await context.processor.process(invoiceEvent("invoice.payment_succeeded", "in_paid"));
  assert.equal(context.orders[0].amount, 129.9);
  assert.equal(context.orders[0].currency, "BRL");
  assert.equal(context.orders[0].status, "paid");
  assert.equal(context.subscription.lastPaymentStatus, "succeeded");
  assert.equal(context.subscription.nextBillingAt.toISOString(), new Date(900_000).toISOString());
  assert.equal(context.subscription.externalId, "sub_historical");
  assert.equal(context.subscription.stripeCustomerId, "cus_historical");
  assert.equal(context.subscription.stripePaymentMethodId, "pm_historical");
});

test("recurring succeeded creates and persists one Shopify order and redelivery does not duplicate it", async () => {
  process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW = "true";
  const context = processorContext();
  const value = invoiceEvent("invoice.payment_succeeded", "in_recurring");
  await context.processor.process(value);
  await context.processor.process(value);
  await context.processor.process({ ...value, id: "evt_redelivery" });
  assert.equal(context.shopifyCalls(), 1);
  assert.equal(context.orders.length, 1);
  assert.equal(context.orders[0].shopifyOrderId, "gid://shopify/Order/999");
});

test("Shopify order failure leaves the webhook unfinished for retry", async () => {
  process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW = "true";
  const context = processorContext();
  context.failShopify();
  const value = invoiceEvent("invoice.payment_succeeded", "in_retry");
  await assert.rejects(context.processor.process(value), /shopify unavailable/);
  assert.equal(context.events.get(value.id)?.processed, false);
  assert.equal(context.orders.length, 0);
});

test("disabled historical flow and failed invoices never create Shopify orders", async () => {
  const disabled = processorContext();
  process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW = "false";
  await disabled.processor.process(invoiceEvent("invoice.payment_succeeded", "in_disabled"));
  assert.equal(disabled.shopifyCalls(), 0);
  const failed = processorContext();
  process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW = "true";
  await failed.processor.process(invoiceEvent("invoice.payment_failed", "in_failed"));
  assert.equal(failed.shopifyCalls(), 0);
  assert.equal(failed.subscription.status, "active");
  assert.equal(failed.subscription.lastPaymentStatus, "failed");
  assert.equal(failed.orders[0].status, "failed");
});

test("payment action required remains challenged and Shopify subscriptions never enter Stripe invoice flow", async () => {
  const challenged = processorContext();
  await challenged.processor.process(invoiceEvent("invoice.payment_action_required", "in_challenged"));
  assert.equal(challenged.subscription.lastPaymentStatus, "challenged");
  assert.equal(challenged.shopifyCalls(), 0);
  const shopify = processorContext("shopify");
  const result = await shopify.processor.process(invoiceEvent("invoice.payment_succeeded", "in_shopify"));
  assert.equal(result.ignored, true);
  assert.equal(shopify.orders.length, 0);
  assert.equal(shopify.shopifyCalls(), 0);
});
