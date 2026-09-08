// src/gifts/__tests__/subscription-gift-settings.test.ts
// Persistência das configurações de brinde: ativação/reativação com fence
// enabledAt, desativar pulando jobs pendentes e validação do payload.

import assert from "node:assert/strict";
import test from "node:test";
import { GiftSettingsService } from "../subscription-gift.settings.service";
import { SubscriptionGiftValidationError } from "../subscription-gift-validation";

const now = new Date("2026-09-08T12:00:00.000Z");
const prior = new Date(now.getTime() - 24 * 60 * 60 * 1000);

function dbFixture() {
  const settingsMap = new Map<string, any>();
  const jobs = new Map<string, Record<string, unknown>>();
  const db: any = {
    subscriptionGiftSettings: {
      findUnique: async ({ where }: any) => settingsMap.get(where.shopId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = settingsMap.get(where.shopId);
        const merged = { ...(existing ?? { createdAt: now }), shopId: where.shopId, ...create, ...update, updatedAt: now };
        settingsMap.set(where.shopId, merged);
        return merged;
      },
    },
    subscriptionGiftJob: {
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const job of jobs.values()) {
          if (job.shopId !== where.shopId) continue;
          if (where.status && job.status !== where.status) continue;
          if (where.commitIntentPersistedAt === null && job.commitIntentPersistedAt != null) continue;
          Object.assign(job, data);
          count += 1;
        }
        return { count };
      },
    },
  };
  const service = new GiftSettingsService({ prisma: db, now: () => now });
  return { db, settingsMap, jobs, service };
}

function randomGroupInput() {
  return {
    enabled: true,
    schedule: "BOTH",
    selectionMode: "RANDOM_GROUP",
    variantPool: [
      { variantId: "gid://shopify/ProductVariant/10", title: "Brinde A" },
      { variantId: "gid://shopify/ProductVariant/11", title: "Brinde B" },
    ],
  };
}

test("primeira ativação registra enabledAt (fence de ordem)", async () => {
  const f = dbFixture();
  const result = await f.service.save("shop-1", randomGroupInput());
  assert.equal(result.settings.enabled, true);
  assert.equal(result.settings.enabledAt, now.toISOString());
  assert.equal(result.skippedJobs, 0);
});

test("reativação já ativa preserva o enabledAt original (sem reset da fence)", async () => {
  const f = dbFixture();
  f.settingsMap.set("shop-1", {
    shopId: "shop-1",
    enabled: true,
    enabledAt: prior,
    schedule: "BOTH",
    selectionMode: "RANDOM_GROUP",
    variantPool: [],
    maxPoolSize: 50,
    createdAt: prior,
    updatedAt: prior,
  });
  await f.service.save("shop-1", randomGroupInput());
  assert.equal(f.settingsMap.get("shop-1").enabledAt.getTime(), prior.getTime());
});

test("reativar depois de desativar reinicia a fence (novo enabledAt)", async () => {
  const f = dbFixture();
  f.settingsMap.set("shop-1", {
    shopId: "shop-1",
    enabled: false,
    enabledAt: prior,
    schedule: "BOTH",
    selectionMode: "RANDOM_GROUP",
    variantPool: [],
    maxPoolSize: 50,
    createdAt: prior,
    updatedAt: prior,
  });
  await f.service.save("shop-1", randomGroupInput());
  assert.equal(f.settingsMap.get("shop-1").enabledAt.getTime(), now.getTime());
});

test("desativar marca como SKIPPED os jobs pendentes sem intenção de commit", async () => {
  const f = dbFixture();
  f.settingsMap.set("shop-1", {
    shopId: "shop-1",
    enabled: true,
    enabledAt: prior,
    schedule: "BOTH",
    selectionMode: "RANDOM_GROUP",
    variantPool: [],
    maxPoolSize: 50,
    createdAt: prior,
    updatedAt: prior,
  });
  f.jobs.set("j1", { shopId: "shop-1", status: "PENDING", commitIntentPersistedAt: null });
  f.jobs.set("j2", { shopId: "shop-1", status: "PENDING", commitIntentPersistedAt: now });
  f.jobs.set("j3", { shopId: "shop-1", status: "COMMIT_PENDING", commitIntentPersistedAt: now });

  const result = await f.service.save("shop-1", { ...randomGroupInput(), enabled: false });
  assert.equal(result.skippedJobs, 1);
  const j1 = f.jobs.get("j1");
  const j2 = f.jobs.get("j2");
  const j3 = f.jobs.get("j3");
  assert.ok(j1);
  assert.ok(j2);
  assert.ok(j3);
  assert.equal(j1.status, "SKIPPED");
  assert.equal(j1.resultCode, "disabled");
  assert.equal(j2.status, "PENDING");
  assert.equal(j3.status, "COMMIT_PENDING");
});

test("validação rejeita sorteio com menos de 2 variantes ao ativar", async () => {
  const f = dbFixture();
  await assert.rejects(
    f.service.save("shop-1", { ...randomGroupInput(), variantPool: [randomGroupInput().variantPool[0]] }),
    (error: unknown) => error instanceof SubscriptionGiftValidationError,
  );
});

test("validação exige variante fixa ao ativar com seleção fixa", async () => {
  const f = dbFixture();
  await assert.rejects(
    f.service.save("shop-1", { ...randomGroupInput(), selectionMode: "FIXED_VARIANT", fixedVariantId: undefined }),
    (error: unknown) => error instanceof SubscriptionGiftValidationError,
  );
});

test("get devolve visualização mapeada ou null", async () => {
  const f = dbFixture();
  assert.equal(await f.service.get("shop-1"), null);
  await f.service.save("shop-1", randomGroupInput());
  const view = await f.service.get("shop-1");
  assert.equal(view?.enabled, true);
  assert.equal(view?.selectionMode, "RANDOM_GROUP");
  assert.equal(view?.variantPool.length, 2);
});