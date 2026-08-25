import test from "node:test";
import assert from "node:assert/strict";
import { PrismaShopifyEventRepository } from "../shopify-event.repository";
import { ShopifyEventValidationError, validateIncomingShopifyEvent } from "../shopify-event.types";

function fixture(options: { installedAt?: Date; uninstalledAt?: Date | null; generation?: number; beforeUpdate?: () => void } = {}) {
  const shop = { domain: "one.myshopify.com", shopifyShopId: "gid://shopify/Shop/1", isActive: true, installationGeneration: options.generation ?? 2, lastInstalledAt: options.installedAt ?? new Date("2026-08-20T00:00:00Z"), lastUninstalledAt: options.uninstalledAt ?? null };
  let cleanup = 0;
  const tx: any = {
    shop: {
      findUnique: async () => ({ installationGeneration: shop.installationGeneration, shopifyShopId: shop.shopifyShopId }),
      updateMany: async ({ where, data }: any) => {
        options.beforeUpdate?.();
        const eligible = shop.isActive && where.domain === shop.domain && where.shopifyShopId === shop.shopifyShopId && where.installationGeneration === shop.installationGeneration && (!shop.lastInstalledAt || shop.lastInstalledAt <= where.AND[0].OR[1].lastInstalledAt.lte) && (!shop.lastUninstalledAt || shop.lastUninstalledAt < where.AND[1].OR[1].lastUninstalledAt.lt);
        if (!eligible) return { count: 0 };
        Object.assign(shop, data); return { count: 1 };
      },
    },
    sendingDomain: { findMany: async () => [], updateMany: async () => { cleanup += 1; return { count: 1 }; } },
    sendingCredentialCleanupJob: { upsert: async () => ({}) }, webhookEvent: { update: async () => ({}) },
  };
  const db: any = { $transaction: async (fn: any) => fn(tx) };
  const repository = new PrismaShopifyEventRepository(db, { emit: async () => ({}) } as never);
  const event = (triggeredAt: Date, webhookId = "delivery-1") => ({ shop: shop.domain, shopifyShopId: shop.shopifyShopId, topic: "app/uninstalled", webhookId, payload: {}, receivedAt: new Date("2026-08-25T00:00:00Z"), triggeredAt } as any);
  return { shop, cleanup: () => cleanup, repository, event };
}

test("uninstall posterior desativa a geração capturada", async () => { const f = fixture(); const at = new Date("2026-08-24T00:00:00Z"); await f.repository.processEvent(f.event(at), "shop-1"); assert.equal(f.shop.isActive, false); assert.deepEqual(f.shop.lastUninstalledAt, at); assert.equal(f.cleanup(), 1); });
test("uninstall anterior entregue depois não desativa reinstalação", async () => { const f = fixture({ installedAt: new Date("2026-08-24T00:00:00Z") }); await f.repository.processEvent(f.event(new Date("2026-08-23T00:00:00Z")), "shop-1"); assert.equal(f.shop.isActive, true); assert.equal(f.cleanup(), 0); });
test("redelivery de uninstall não repete efeitos", async () => { const at = new Date("2026-08-24T00:00:00Z"); const f = fixture({ uninstalledAt: at }); await f.repository.processEvent(f.event(at, "delivery-2"), "shop-1"); assert.equal(f.shop.isActive, true); assert.equal(f.cleanup(), 0); });
test("triggeredAt ausente é inválido", () => { assert.throws(() => validateIncomingShopifyEvent({ shop: "one.myshopify.com", shopifyShopId: "gid://shopify/Shop/1", topic: "app/uninstalled", webhookId: "w1", payload: {}, receivedAt: "2026-08-25T00:00:00Z" }), ShopifyEventValidationError); });
test("triggeredAt inválido é inválido", () => { assert.throws(() => validateIncomingShopifyEvent({ shop: "one.myshopify.com", shopifyShopId: "gid://shopify/Shop/1", topic: "app/uninstalled", webhookId: "w1", payload: {}, triggeredAt: "invalid", receivedAt: "2026-08-25T00:00:00Z" }), ShopifyEventValidationError); });
test("worker perdedor não desativa após mudança de geração", async () => { const f = fixture({ beforeUpdate: () => { f.shop.installationGeneration += 1; } }); await f.repository.processEvent(f.event(new Date("2026-08-24T00:00:00Z")), "shop-1"); assert.equal(f.shop.isActive, true); assert.equal(f.cleanup(), 0); });
test("uninstall numérico equivalente ao GID canônico desativa", async () => { const f = fixture(); await f.repository.processEvent({ ...f.event(new Date("2026-08-24T00:00:00Z")), shopifyShopId: "1" }, "shop-1"); assert.equal(f.shop.isActive, false); assert.equal(f.cleanup(), 1); });
test("uninstall de shopId diferente é rejeitado sem cleanup", async () => { const f = fixture(); await assert.rejects(f.repository.processEvent({ ...f.event(new Date("2026-08-24T00:00:00Z")), shopifyShopId: "gid://shopify/Shop/2" }, "shop-1")); assert.equal(f.shop.isActive, true); assert.equal(f.cleanup(), 0); });
