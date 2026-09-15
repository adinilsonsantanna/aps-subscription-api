// src/gifts/__tests__/subscription-gift-jobs.test.ts
// Enqueue de brindes: idempotência (shopId, orderKey), fence anti-replay de
// idade do pedido e tratamento de concorrência P2002.

import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { enqueueGiftJob } from "../subscription-gift.jobs";

const now = new Date("2026-09-08T12:00:00.000Z");

function txFixture() {
  const jobs = new Map<string, Record<string, unknown>>();
  let upsertCalls = 0;
  const transaction: any = {
    subscriptionGiftJob: {
      upsert: async ({ where, create }: any) => {
        upsertCalls += 1;
        const orderKey = where.shopId_orderKey.orderKey;
        if (jobs.has(orderKey)) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on subscription_gift_job(s): (shopId, orderKey)",
            { code: "P2002", clientVersion: "test" },
          );
        }
        jobs.set(orderKey, { ...create });
        return { id: create.orderId ?? "new-id" };
      },
    },
  };
  return { transaction, jobs, upsertCalls: () => upsertCalls };
}

const truthy = { shopId: "shop-1", installationGeneration: 1, orderId: "gid://shopify/Order/1001", scheduleKind: "RENEWALS" as const };

test("cria job pendente para pedido recente", async () => {
  const f = txFixture();
  const result = await enqueueGiftJob(f.transaction, { ...truthy, orderProcessedAt: now, orderCurrencyCode: "BRL", subscriptionId: "sub-1" }, now);
  assert.deepEqual(result, { created: true, existing: false });
  assert.equal(f.jobs.size, 1);
  const created = f.jobs.values().next().value;
  assert.ok(created);
  assert.equal(created.shopId, "shop-1");
  assert.equal(created.orderKey, "shop-1:gid://shopify/Order/1001");
  assert.equal(created.status, "PENDING");
  assert.equal(created.scheduleKind, "RENEWALS");
  assert.equal(created.installationGeneration, 1);
  assert.deepEqual(created.orderProcessedAt, now);
});

test("webhook repetido é idempotente e cria somente um job", async () => {
  const f = txFixture();
  await enqueueGiftJob(f.transaction, truthy, now);
  const second = await enqueueGiftJob(f.transaction, truthy, now);
  assert.equal(second.created, false);
  assert.equal(second.existing, true);
  assert.equal(f.jobs.size, 1);
  assert.equal(f.upsertCalls(), 2);
});

test("pedidos antigos não recebem brinde (fence anti-replay de idade)", async () => {
  const f = txFixture();
  const old = new Date(now.getTime() - 200 * 60 * 60 * 1000);
  const result = await enqueueGiftJob(f.transaction, { ...truthy, orderProcessedAt: old }, now);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "order_too_old");
  assert.equal(f.jobs.size, 0);
  assert.equal(f.upsertCalls(), 0);
});

test("sem orderId o job é pulado sem contato com banco", async () => {
  const f = txFixture();
  const result = await enqueueGiftJob(f.transaction, { ...truthy, orderId: null }, now);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "order_id_missing");
  assert.equal(f.jobs.size, 0);
});

test("orderProcessedAt inválido não cria job com data quebrada", async () => {
  const f = txFixture();
  const result = await enqueueGiftJob(f.transaction, { ...truthy, orderProcessedAt: "data-invalida" }, now);
  assert.equal(result.created, true);
  const created = f.jobs.values().next().value;
  assert.ok(created);
  assert.equal(created.orderProcessedAt, undefined);
});