import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

test("generated Prisma client executes SubscriptionOrder creation with currencyCode", async () => {
  let received: Record<string, unknown> | undefined;
  const prisma = new PrismaClient().$extends({ query: { subscriptionOrder: { async create({ args }) { received = args.data as unknown as Record<string, unknown>; return { id: "order-test", ...args.data } as never; } } } });
  try {
    await prisma.subscriptionOrder.create({ data: { subscriptionId: "subscription-test", gatewayOrderId: "in_repository", amount: new Prisma.Decimal(0), currencyCode: "BRL", status: "paid", processedAt: new Date("2026-08-17T12:00:00.000Z") } });
    assert.equal(received?.currencyCode, "BRL");
    assert.equal("currency" in (received ?? {}), false);
  } finally {
    await prisma.$disconnect();
  }
});
