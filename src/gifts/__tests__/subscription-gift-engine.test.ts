// src/gifts/__tests__/subscription-gift-engine.test.ts
// Testes do motor de brindes com Prisma e cliente Shopify falsos (in-memory).
// Cobre: seleção, estoque, regras de ativação, segurança de total, commit
// incerto/confirmação, replay/instalação e concorrência (lease/claim).

import assert from "node:assert/strict";
import test from "node:test";
import { SubscriptionGiftEngine } from "../subscription-gift-engine";

const now = new Date("2026-09-08T12:00:00.000Z");

const eligibleVariantA = {
  variantId: "gid://shopify/ProductVariant/10",
  sku: "G-1",
  title: "Brinde A",
  productId: "gid://shopify/Product/1",
  productTitle: "Produto A",
  requiresShipping: true,
  tracked: true,
  productActive: true,
  available: 3,
  availableAtLocation: true,
};
const eligibleVariantB = {
  variantId: "gid://shopify/ProductVariant/11",
  sku: "G-2",
  title: "Brinde B",
  productId: "gid://shopify/Product/2",
  productTitle: "Produto B",
  requiresShipping: true,
  tracked: true,
  productActive: true,
  available: 1,
  availableAtLocation: true,
};

function jobFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    shopId: "shop-1",
    orderId: "gid://shopify/Order/1001",
    orderKey: "shop-1:gid://shopify/Order/1001",
    scheduleKind: "RENEWALS" as const,
    orderProcessedAt: now,
    orderCurrencyCode: "BRL",
    subscriptionId: "sub-1",
    status: "PENDING",
    chosenVariantId: null,
    chosenVariantSku: null,
    chosenProductId: null,
    chosenTitle: null,
    candidatesWithStock: 0,
    candidatePoolSnapshot: null,
    installationGeneration: 1,
    resultCode: null,
    resultMessage: null,
    orderEditId: null,
    calculatedOrderId: null,
    giftLineDeterminativeId: null,
    giftLineIdentifier: null,
    orderTotalBefore: null,
    orderShippingBefore: null,
    orderTotalAfterComputed: null,
    commitIntentPersistedAt: null,
    attemptCount: 0,
    maxAttempts: 3,
    claimToken: null,
    claimedAt: null,
    leaseExpiresAt: null,
    availableAt: now,
    lastError: null,
    reviewRequiredAt: null,
    reviewedAt: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any;
}

function shopFixture(overrides: Record<string, unknown> = {}) {
  return { id: "shop-1", domain: "one.myshopify.com", accessToken: "token-1", isActive: true, installationGeneration: 1, ...overrides } as any;
}

function settingsFixture(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop-1",
    enabled: true,
    enabledAt: new Date(now.getTime() - 60 * 60 * 1000),
    schedule: "BOTH",
    selectionMode: "RANDOM_GROUP",
    fixedVariantId: null,
    fixedProductId: null,
    fixedTitle: null,
    fixedSku: null,
    variantPool: [
      { variantId: "gid://shopify/ProductVariant/10", title: "Brinde A" },
      { variantId: "gid://shopify/ProductVariant/11", title: "Brinde B" },
    ],
    maxPoolSize: 50,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as any;
}

function shopifyFixture(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const shopify: any = {
    fetchOrderForGift: async () => overrides.order ?? {
      id: "gid://shopify/Order/1001",
      legacyResourceId: "1001",
      cancelledAt: null,
      closedAt: null,
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: null,
      processedAt: now.toISOString(),
      totalShopMoney: 100.0,
      shippingShopMoney: 10.0,
      currencyCode: "BRL",
      servingLocationIds: ["gid://shopify/Location/1"],
    },
    fetchVariantEligibility: async () => {
      calls.push("fetchVariantEligibility");
      return overrides.variants ?? [eligibleVariantA, eligibleVariantB];
    },
    orderEditBegin: async () => {
      calls.push("orderEditBegin");
      return { data: { orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/9", totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "BRL" } }, shippingLines: [{ id: "sl-1", price: { shopMoney: { amount: "10.00", currencyCode: "BRL" } } }] }, userErrors: [] } } };
    },
    orderEditAddVariant: async () => {
      calls.push("orderEditAddVariant");
      return { data: { orderEditAddVariant: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/9", totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "BRL" } }, shippingLines: [{ id: "sl-1", price: { shopMoney: { amount: "10.00", currencyCode: "BRL" } } }] }, calculatedLineItem: { id: "gid://shopify/CalculatedLineItem/55", quantity: 1 }, userErrors: [] } } };
    },
    orderEditAddLineItemDiscount: async () => {
      calls.push("orderEditAddLineItemDiscount");
      return { data: { orderEditAddLineItemDiscount: { calculatedOrder: overrides.afterDiscount ?? { id: "gid://shopify/CalculatedOrder/9", totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "BRL" } }, shippingLines: [{ id: "sl-1", price: { shopMoney: { amount: "10.00", currencyCode: "BRL" } } }] }, userErrors: [] } } };
    },
    orderEditCommit: async () => {
      calls.push("orderEditCommit");
      if (overrides.commitThrows === "timeout") {
        const error: any = new Error("Tempo esgotado");
        error.name = "AbortError";
        throw error;
      }
      if (overrides.commitUserErrors) {
        return { data: { orderEditCommit: { order: null, userErrors: [{ field: null, message: overrides.commitUserErrors }] } } };
      }
      return { data: { orderEditCommit: { order: { id: "gid://shopify/Order/1001" }, userErrors: [] } } };
    },
    queryOrderGiftLines: async () => overrides.giftLines ?? [{ lineId: "gid://shopify/LineItem/77", title: "Brinde A", discountedUnitPrice: 0 }],
  };
  return { shopify, calls };
}

function dbFixture(overrides: Record<string, unknown> = {}) {
  const job = overrides.job ?? jobFixture();
  const shop = overrides.shop ?? shopFixture();
  const settings = overrides.settings ?? settingsFixture();
  const jobs: Map<string, any> = (overrides.jobs as Map<string, any> | undefined) ?? new Map([[job.id, job]]);
  const shops: Map<string, any> = (overrides.shops as Map<string, any> | undefined) ?? new Map([["shop-1", shop]]);
  const settingsMap: Map<string, any> = (overrides.settingsMap as Map<string, any> | undefined) ?? new Map([["shop-1", settings]]);
  const nowFix: Date = (overrides.now as Date | undefined) ?? now;
  const db: any = {
    shop: {
      findUnique: async ({ where }: any) => shops.get(where.id) ?? null,
    },
    subscriptionGiftSettings: {
      findUnique: async ({ where }: any) => settingsMap.get(where.shopId) ?? null,
    },
    subscriptionGiftJob: {
      updateMany: async ({ where, data }: any) => {
        const matched = [...jobs.values()].filter((j) => {
          if (where?.status && j.status !== where.status) return false;
          if (where?.shopId && j.shopId !== where.shopId) return false;
          if (where?.commitIntentPersistedAt?.not && j.commitIntentPersistedAt == null) return false;
          if (where?.reviewedAt === null && j.reviewedAt !== null) return false;
          if (where?.claimedAt?.not && j.claimedAt == null) return false;
          if (where?.leaseExpiresAt?.lt && !(j.leaseExpiresAt && j.leaseExpiresAt.getTime() < where.leaseExpiresAt.lt.getTime())) return false;
          if (where?.reviewRequiredAt?.not && j.reviewRequiredAt === null) return false;
          if (j.status === "PENDING" && !where.commitIntentPersistedAt) {
            const leaseFree = j.leaseExpiresAt == null || j.leaseExpiresAt.getTime() <= nowFix.getTime();
            const available = j.availableAt == null || j.availableAt.getTime() <= nowFix.getTime();
            if (!leaseFree || !available) return false;
          }
          return true;
        });
        for (const j of matched) Object.assign(j, data);
        return { count: matched.length };
      },
      findMany: async ({ where, take, orderBy }: any) => {
        let rows = [...jobs.values()];
        if (where?.claimToken) rows = rows.filter((j) => j.claimToken === where.claimToken);
        if (where?.shopId) rows = rows.filter((j) => j.shopId === where.shopId);
        if (where?.status) rows = rows.filter((j) => j.status === where.status);
        if (where?.reviewRequiredAt?.not) {
          rows = rows.filter((j) => j.reviewRequiredAt !== null && j.updatedAt.getTime() < where.reviewRequiredAt.lt?.getTime());
        }
        void orderBy;
        return rows.slice(0, take ?? rows.length);
      },
      update: async ({ where, data }: any) => {
        const current = jobs.get(where.id);
        if (current) {
          for (const [key, value] of Object.entries<any>(data)) {
            if (value && typeof value === "object" && "increment" in value) {
              current[key] = (Number(current[key]) || 0) + Number(value.increment);
            } else {
              current[key] = value;
            }
          }
        }
        return current;
      },
      findUnique: async ({ where }: any) => jobs.get(where.id) ?? null,
    },
    $transaction: async (callback: any) => callback(db),
  };
  return { db, job, shop, settings, jobs, shops, settingsMap };
}

function buildEngine(f: ReturnType<typeof dbFixture>, s: ReturnType<typeof shopifyFixture>, featureEnabled = () => true) {
  return new SubscriptionGiftEngine({
    prisma: f.db,
    shopify: s.shopify as any,
    now: () => now,
    randomInt: () => 0,
    featureEnabled,
    deadlineMs: 1_000,
  });
}

test("sorteia do grupo com estoque e inclui brinde gratuito no commit", async () => {
  const f = dbFixture();
  const s = shopifyFixture();
  await buildEngine(f, s).processShop("shop-1");
  const job = f.job;
  assert.equal(job.status, "COMMITTED");
  assert.equal(job.resultCode, "gift_added");
  assert.equal(job.chosenVariantId, eligibleVariantA.variantId);
  assert.equal(job.chosenTitle, "Brinde A");
  assert.equal(Number(job.orderTotalAfterComputed), 100);
  assert.ok(s.calls.includes("orderEditBegin"));
  assert.ok(s.calls.includes("orderEditAddVariant"));
  assert.ok(s.calls.includes("orderEditAddLineItemDiscount"));
  assert.ok(s.calls.includes("orderEditCommit"));
});

test("variante fixa selecionada quando disponível", async () => {
  const f = dbFixture({ settings: settingsFixture({ selectionMode: "FIXED_VARIANT", fixedVariantId: "gid://shopify/ProductVariant/10", fixedProductId: "gid://shopify/Product/1", fixedTitle: "Brinde A" }) });
  const s = shopifyFixture();
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "COMMITTED");
  assert.equal(f.job.chosenVariantId, "gid://shopify/ProductVariant/10");
});

test("sem estoque disponível (continue selling) gera no_stock e não edita o pedido", async () => {
  const noStock = { ...eligibleVariantA, available: 0, availableAtLocation: false };
  const f = dbFixture({ settings: settingsFixture({ selectionMode: "FIXED_VARIANT", fixedVariantId: noStock.variantId, fixedVariantTitle: "Brinde A" }) });
  const s = shopifyFixture({ variants: [noStock] });
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "no_stock");
  assert.equal(f.job.candidatesWithStock, 0);
  assert.ok(!s.calls.includes("orderEditBegin"));
});

test("produto inativo excluído da eligibilidade resulta em no_stock sem editar", async () => {
  const inactive = { ...eligibleVariantA, productActive: false };
  const f = dbFixture({ settings: settingsFixture({ selectionMode: "FIXED_VARIANT", fixedVariantId: inactive.variantId, fixedTitle: "Inativo" }) });
  const s = shopifyFixture({ variants: [inactive] });
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "no_stock");
  assert.ok(!s.calls.includes("orderEditBegin"));
});

test("pedido cancelado, já atendido ou não pago gera skip específico", async () => {
  for (const [orderPatch, expected] of [
    [{ cancelledAt: now.toISOString() }, "order_cancelled"],
    [{ displayFulfillmentStatus: "FULFILLED" }, "order_fulfilled"],
    [{ displayFinancialStatus: "PENDING" }, "order_not_paid"],
  ] as const) {
    const f = dbFixture();
    const baseOrder = await shopifyFixture().shopify.fetchOrderForGift("d", "t", "o");
    const s = shopifyFixture({ order: { ...baseOrder, ...orderPatch } });
    await buildEngine(f, s).processShop("shop-1");
    assert.equal(f.job.status, "SKIPPED", JSON.stringify(orderPatch));
    assert.equal(f.job.resultCode, expected);
    assert.ok(!s.calls.includes("orderEditBegin"));
  }
});

test("pedido anterior à ativação não recebe brinde (sem brinde retroativo)", async () => {
  const f = dbFixture({ job: jobFixture({ orderProcessedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) }) });
  const s = shopifyFixture();
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "predates_gift_enablement");
});

test("regra de agenda divergente gera skip", async () => {
  const f = dbFixture({ settings: settingsFixture({ schedule: "FIRST_ORDER" }) });
  const s = shopifyFixture();
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "schedule_no_match");
});

test("brindes desativados ou sem configuração geram skip", async () => {
  const f = dbFixture({ settings: settingsFixture({ enabled: false }) });
  const s = shopifyFixture();
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "disabled");
});

test("feature flag desligada bloqueia o processamento", async () => {
  const f = dbFixture();
  const s = shopifyFixture();
  await buildEngine(f, s, () => false).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "feature_disabled");
  assert.equal(s.calls.length, 0);
});

test("instalação antiga ou loja inativa bloqueia o job", async () => {
  const changed = dbFixture({ shop: shopFixture({ installationGeneration: 2 }) });
  await buildEngine(changed, shopifyFixture()).processShop("shop-1");
  assert.equal(changed.job.status, "SKIPPED");
  assert.equal(changed.job.resultCode, "installation_changed");

  const inactive = dbFixture({ shop: shopFixture({ isActive: false }) });
  await buildEngine(inactive, shopifyFixture()).processShop("shop-1");
  assert.equal(inactive.job.resultCode, "installation_blocked");
});

test("edição que aumentaria o total não comita o brinde", async () => {
  const f = dbFixture();
  const s = shopifyFixture({ afterDiscount: { id: "gid://shopify/CalculatedOrder/9", totalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "BRL" } }, shippingLines: [] } });
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "SKIPPED");
  assert.equal(f.job.resultCode, "would_increase_total");
  assert.ok(!s.calls.includes("orderEditCommit"));
});

test("commit incerto é confirmado lendo a linha gratuita no pedido", async () => {
  const f = dbFixture();
  const s = shopifyFixture({ commitThrows: "timeout" });
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "COMMITTED");
  assert.equal(f.job.resultCode, "gift_confirmed");
  assert.equal(f.job.giftLineIdentifier, "gid://shopify/LineItem/77");
});

test("commit rejeitado pela Shopify gera FAILED sem nova tentativa automática", async () => {
  const f = dbFixture();
  const s = shopifyFixture({ commitUserErrors: "not allowed to edit this order" });
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "FAILED");
  assert.equal(f.job.resultCode, "commit_rejected");
  assert.equal(f.job.attemptCount, 1);
});

test("worker que perde o claim atômico não realiza nenhuma chamada externa", async () => {
  const f = dbFixture();
  const s = shopifyFixture();
  const original = f.db.subscriptionGiftJob.updateMany;
  f.db.subscriptionGiftJob.updateMany = async () => ({ count: 0 });
  const metrics = await buildEngine(f, s).processShop("shop-1");
  assert.equal(metrics.found, 0);
  assert.equal(metrics.claimed, 0);
  assert.equal(s.calls.length, 0);
  f.db.subscriptionGiftJob.updateMany = original;
});

test("recoverStale converte COMMIT_PENDING com lease expirado em UNCERTAIN", async () => {
  const stale = jobFixture({ status: "COMMIT_PENDING", chosenVariantId: eligibleVariantA.variantId, commitIntentPersistedAt: now, leaseExpiresAt: new Date(now.getTime() - 1) });
  const f = dbFixture({ job: stale, jobs: new Map([["job-1", stale]]) });
  const s = shopifyFixture({ giftLines: [] });
  const metrics = await buildEngine(f, s).recoverStale(new Date(now.getTime() + 1000));
  assert.equal(stale.status, "UNCERTAIN");
  assert.equal(stale.resultCode, "commit_uncertain");
  assert.equal(metrics.uncertain, 1);
});

test("pedido sem local de atendimento é aceito quando há estoque em algum local", async () => {
  const f = dbFixture();
  const s = shopifyFixture({ order: { id: "gid://shopify/Order/1001", legacyResourceId: "1001", cancelledAt: null, closedAt: null, displayFinancialStatus: "PAID", displayFulfillmentStatus: null, processedAt: now.toISOString(), totalShopMoney: 100, shippingShopMoney: 10, currencyCode: "BRL", servingLocationIds: [] } });
  await buildEngine(f, s).processShop("shop-1");
  assert.equal(f.job.status, "COMMITTED");
});