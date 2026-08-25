import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ShopIdentityConflictError, ShopRepository } from "../ShopRepository";

type Row = { id: string; domain: string; shopifyShopId: string; name: string; accessToken: string; scopes: string; isActive: boolean; installationGeneration: number; lastInstalledAt: Date | null; lastUninstalledAt: Date | null; createdAt: Date; updatedAt: Date };

class FakePrisma {
  rows: Row[] = [];
  private tail = Promise.resolve();
  failNextUpdate = false;
  shop = this.client();

  private client() {
    return {
      findUnique: async ({ where }: any) => this.rows.find((row) => Object.entries(where).every(([key, value]) => (row as any)[key] === value)) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const row = this.rows.find((item) => item.id === where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      create: async ({ data }: any) => {
        if (this.rows.some((row) => row.domain === data.domain || row.shopifyShopId === data.shopifyShopId)) throw new Error("unique");
        const now = new Date();
        const row = { id: `shop-${this.rows.length + 1}`, createdAt: now, updatedAt: now, lastInstalledAt: null, lastUninstalledAt: null, installationGeneration: 0, isActive: true, ...data } as Row;
        this.rows.push(row); return row;
      },
      update: async ({ where, data }: any) => { const row = this.rows.find((item) => item.id === where.id)!; Object.assign(row, data, { updatedAt: new Date() }); return row; },
      updateMany: async ({ where, data }: any) => {
        if (this.failNextUpdate) { this.failNextUpdate = false; throw new Error("forced rollback"); }
        const row = this.rows.find((item) => item.id === where.id && item.domain === where.domain && item.isActive === where.isActive && item.installationGeneration === where.installationGeneration && (where.shopifyShopId === undefined || item.shopifyShopId === where.shopifyShopId));
        if (!row) return { count: 0 };
        Object.assign(row, data, { installationGeneration: row.installationGeneration + (data.installationGeneration?.increment ?? 0), updatedAt: new Date() });
        return { count: 1 };
      },
      findMany: async () => this.rows,
    };
  }

  async $transaction<T>(fn: (tx: any) => Promise<T>) {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = this.rows.map((row) => ({ ...row }));
    try { return await fn({ shop: this.client() }); }
    catch (error) { this.rows = snapshot; throw error; }
    finally { release(); }
  }
}

const install = { domain: "one.myshopify.com", shopifyShopId: "gid://shopify/Shop/1", name: "One", accessToken: "token-1", scopes: "read_products" };
function fixture(rows: Partial<Row>[] = []) { const db = new FakePrisma(); db.rows = rows.map((row, index) => ({ id: `shop-${index + 1}`, createdAt: new Date(0), updatedAt: new Date(0), lastInstalledAt: null, lastUninstalledAt: null, installationGeneration: 0, isActive: true, ...install, ...row })); return { db, repository: new ShopRepository(db as any) }; }

test("install nova cria uma geração ativa", async () => { const f = fixture(); const row = await f.repository.installOrReactivate(install); assert.equal(row.isActive, true); assert.equal(row.installationGeneration, 1); assert.ok(row.lastInstalledAt); });
test("reinstall inativa incrementa geração uma vez e limpa uninstall", async () => { const f = fixture([{ isActive: false, installationGeneration: 3, lastUninstalledAt: new Date() }]); const row = await f.repository.installOrReactivate(install); assert.equal(row.installationGeneration, 4); assert.equal(row.lastUninstalledAt, null); });
test("retry idempotente não incrementa geração", async () => { const f = fixture([{ installationGeneration: 4 }]); await f.repository.installOrReactivate(install); const row = await f.repository.installOrReactivate(install); assert.equal(row.installationGeneration, 4); });
test("token refresh atualiza token sem criar instalação", async () => { const f = fixture([{ installationGeneration: 2 }]); const row = await f.repository.installOrReactivate({ ...install, accessToken: "token-2" }); assert.equal(row.accessToken, "token-2"); assert.equal(row.installationGeneration, 2); });
test("domínio incompatível é rejeitado", async () => { const f = fixture(); await f.repository.installOrReactivate(install); await assert.rejects(f.repository.installOrReactivate({ ...install, domain: "other.myshopify.com" }), ShopIdentityConflictError); });
test("shopId incompatível é rejeitado", async () => { const f = fixture(); await f.repository.installOrReactivate(install); await assert.rejects(f.repository.installOrReactivate({ ...install, shopifyShopId: "gid://shopify/Shop/2" }), ShopIdentityConflictError); });
test("duas lojas permanecem isoladas", async () => { const f = fixture(); await f.repository.installOrReactivate(install); await f.repository.installOrReactivate({ ...install, domain: "two.myshopify.com", shopifyShopId: "gid://shopify/Shop/2" }); assert.equal(f.db.rows.length, 2); });
test("race com Promise.all tem um único vencedor de reativação", async () => { const f = fixture([{ isActive: false, installationGeneration: 7 }]); const rows = await Promise.all([f.repository.installOrReactivate(install), f.repository.installOrReactivate({ ...install, accessToken: "token-2" })]); assert.equal(f.db.rows[0].installationGeneration, 8); assert.equal(rows.every((row) => row.isActive), true); });
test("rollback preserva loja inativa quando update falha", async () => { const f = fixture([{ isActive: false, installationGeneration: 1 }]); f.db.failNextUpdate = true; await assert.rejects(f.repository.installOrReactivate(install)); assert.equal(f.db.rows[0].isActive, false); assert.equal(f.db.rows[0].installationGeneration, 1); });
test("migration preserva isActive histórico e timestamps desconhecidos", async () => { const sql = await readFile(join(process.cwd(), "prisma/migrations/20260825120000_add_durable_lifecycle_fields/migration.sql"), "utf8"); assert.doesNotMatch(sql, /UPDATE\s+"Shop"/i); assert.match(sql, /installationGeneration" INTEGER NOT NULL DEFAULT 0/); assert.match(sql, /lastInstalledAt" TIMESTAMP\(3\)(?:,|\s)/); assert.doesNotMatch(sql, /lastInstalledAt"[^,;]*DEFAULT/i); });
