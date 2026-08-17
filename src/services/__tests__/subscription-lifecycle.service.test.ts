import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { LifecycleError, SubscriptionLifecycleService } from "../SubscriptionLifecycleService";

function setup(overrides: Record<string, unknown> = {}) {
  const subscription = { id: "aps-1", gateway: "stripe", externalId: "sub_123", shopifyContractId: null, status: "active", lastPaymentStatus: "succeeded", lastGatewayEventAt: null, shop: { domain: "known.myshopify.com" }, ...overrides };
  const actions: any[] = [];
  const history: any[] = [];
  const prisma: any = {
    subscription: { findUnique: async () => subscription, update: async ({ data }: any) => Object.assign(subscription, data) },
    subscriptionLifecycleAction: {
      findUnique: async ({ where }: any) => actions.find((a) => a.idempotencyKey === where.subscriptionId_idempotencyKey.idempotencyKey) || null,
      findFirst: async () => actions.find((a) => a.status === "pending") || null,
      create: async ({ data }: any) => { if (actions.some((a) => a.subscriptionId === data.subscriptionId && a.status === "pending")) throw new Prisma.PrismaClientKnownRequestError("pending conflict", { code: "P2002", clientVersion: "test" }); const value = { id: `action-${actions.length + 1}`, externalStatus: null, httpStatus: null, ...data }; actions.push(value); return value; },
      update: async ({ where, data }: any) => Object.assign(actions.find((a) => a.id === where.id), data),
    },
    subscriptionStatusHistory: { create: async ({ data }: any) => { history.push(data); return data; } },
    $transaction: async (arg: any) => typeof arg === "function" ? arg(prisma) : Promise.all(arg),
  };
  const calls: string[] = [];
  const stripe: any = { pause: async (id: string) => { calls.push(`stripe:pause:${id}`); return { id }; }, resume: async (id: string) => { calls.push(`stripe:resume:${id}`); return { id }; }, cancel: async (id: string) => { calls.push(`stripe:cancel:${id}`); return { id }; } };
  const fetchFn: any = async () => { calls.push("shopify"); return Response.json({ success: true, status: "PAUSED" }); };
  return { service: new SubscriptionLifecycleService(prisma, stripe, fetchFn), subscription, actions, history, calls };
}

test("routes pause, resume and cancel only to Stripe for historical subscriptions", async () => { for (const action of ["pause", "resume", "cancel"] as const) { const context = setup({ status: action === "resume" ? "paused" : "active" }); await context.service.execute("aps-1", action, `key-${action}`); assert.deepEqual(context.calls, [`stripe:${action}:sub_123`]); } });
test("routes Shopify subscription only to the App endpoint", async () => { process.env.SHOPIFY_APP_URL = "https://app.example"; process.env.SHOPIFY_APP_API_KEY = "secret"; const context = setup({ gateway: "shopify", externalId: null, shopifyContractId: "gid://shopify/SubscriptionContract/1" }); await context.service.execute("aps-1", "pause", "key-shopify"); assert.deepEqual(context.calls, ["shopify"]); assert.equal(context.subscription.status, "active"); });
test("rejects missing gateway and impossible terminal transitions", async () => { await assert.rejects(setup({ gateway: null }).service.execute("aps-1", "pause", "key-1"), (e: LifecycleError) => e.code === "invalid_gateway"); await assert.rejects(setup({ status: "cancelled" }).service.execute("aps-1", "resume", "key-2"), (e: LifecycleError) => e.statusCode === 409); });
test("completed idempotency key returns the same result without another external call", async () => { const context = setup(); const first = await context.service.execute("aps-1", "pause", "same-key"); const second = await context.service.execute("aps-1", "pause", "same-key"); assert.equal(context.calls.length, 1); assert.equal(second.duplicate, true); assert.equal(first.status, second.status); });
test("a failed external call does not update subscription status", async () => { const context = setup(); (context.service as any).stripe.pause = async () => { throw new Error("secret upstream error"); }; await assert.rejects(context.service.execute("aps-1", "pause", "failed-key"), (e: LifecycleError) => e.code === "external_gateway_error"); assert.equal(context.subscription.status, "active"); assert.equal(context.actions[0].status, "failed"); assert.equal(context.actions[0].errorMessage.includes("secret upstream"), false); });
test("replays a completed failure without another external call", async () => { const context = setup(); let calls = 0; (context.service as any).stripe.pause = async () => { calls += 1; throw new Error("failure"); }; await assert.rejects(context.service.execute("aps-1", "pause", "failed-replay"), (e: LifecycleError) => e.statusCode === 502); await assert.rejects(context.service.execute("aps-1", "pause", "failed-replay"), (e: LifecycleError) => e.code === "external_gateway_error"); assert.equal(calls, 1); });
test("Promise.all with different keys permits only one pending external action", async () => { const context = setup(); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); (context.service as any).stripe.pause = async (id: string) => { context.calls.push(`stripe:pause:${id}`); await gate; return { id }; }; const first = context.service.execute("aps-1", "pause", "concurrent-a"); const second = context.service.execute("aps-1", "pause", "concurrent-b"); const settled = Promise.allSettled([first, second]); await new Promise((resolve) => setImmediate(resolve)); release(); const results = await settled; assert.equal(results.filter((result) => result.status === "fulfilled").length, 1); assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof LifecycleError && result.reason.statusCode === 409).length, 1); assert.equal(context.calls.length, 1); });
