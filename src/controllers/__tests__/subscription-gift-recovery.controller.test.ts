import assert from "node:assert/strict";
import test from "node:test";
import { SubscriptionGiftRecoveryController } from "../SubscriptionGiftRecoveryController";

function response() { const state = { status: 200, body: undefined as unknown }; return { state, value: { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } } }; }
function request(jobId: string, secret = "cron-test") { return { query: { jobId }, headers: { authorization: `Bearer ${secret}` } }; }
const id = "cmu5q5t5e0003jw04zv6faoqy";

test("recovery rejeita job diferente do allowlist", async () => {
  process.env.CRON_SECRET = "cron-test";
  const output = response();
  await new SubscriptionGiftRecoveryController({} as never, {} as never).run(request("outro") as never, output.value as never);
  assert.equal(output.state.status, 404);
});

test("recovery confirma linhas existentes e atualiza somente job COMMIT_PENDING", async () => {
  process.env.CRON_SECRET = "cron-test";
  const updates: unknown[] = [];
  const prisma = {
    subscriptionGiftJob: {
      findUnique: async () => ({ id, status: "COMMIT_PENDING", orderId: "order", shop: { domain: "shop.myshopify.com", accessToken: "token" } }),
      updateMany: async (args: unknown) => { updates.push(args); return { count: 1 }; },
    },
  };
  const shopify = { queryOrderGiftLines: async () => [
    { lineId: "paid", title: "Principal", discountedUnitPrice: 10 },
    { lineId: "gift", title: "Brinde", discountedUnitPrice: 0 },
  ] };
  const output = response();
  await new SubscriptionGiftRecoveryController(prisma as never, shopify as never).run(request(id) as never, output.value as never);
  assert.equal(output.state.status, 200);
  assert.equal((output.state.body as { resultCode: string }).resultCode, "recovered_from_commit_pending");
  assert.equal(updates.length, 1);
  assert.equal((updates[0] as { where: { id: string; status: string } }).where.status, "COMMIT_PENDING");
});

test("recovery não atualiza job sem linha paga e linha gratuita", async () => {
  process.env.CRON_SECRET = "cron-test";
  let updated = false;
  const prisma = { subscriptionGiftJob: { findUnique: async () => ({ id, status: "COMMIT_PENDING", orderId: "order", shop: { domain: "shop.myshopify.com", accessToken: "token" } }), updateMany: async () => { updated = true; return { count: 1 }; } } };
  const shopify = { queryOrderGiftLines: async () => [{ lineId: "gift", title: "Brinde", discountedUnitPrice: 0 }] };
  const output = response();
  await new SubscriptionGiftRecoveryController(prisma as never, shopify as never).run(request(id) as never, output.value as never);
  assert.equal(output.state.status, 409);
  assert.equal(updated, false);
});
