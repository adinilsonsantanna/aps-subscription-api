import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

const url = process.env.TEST_DATABASE_URL;
const live = url ? test : test.skip;

live("PostgreSQL commits, rolls back, enforces uniqueness, isolates tenants and atomically claims once", async () => {
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error("TEST_DATABASE_URL must be an isolated PostgreSQL URL");
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  const schema = `scope9_${process.pid}_${Date.now()}`;
  if (!/^scope9_\d+_\d+$/.test(schema)) throw new Error("unsafe test schema name");
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".jobs (id text PRIMARY KEY, shop_id text NOT NULL, external_id text NOT NULL, status text NOT NULL, UNIQUE(shop_id, external_id))`);
    await db.$transaction(async tx => { await tx.$executeRawUnsafe(`INSERT INTO "${schema}".jobs VALUES ('commit','shop-a','same','pending')`); });
    await assert.rejects(db.$transaction(async tx => { await tx.$executeRawUnsafe(`INSERT INTO "${schema}".jobs VALUES ('rollback','shop-a','rollback','pending')`); throw new Error("force rollback"); }), /force rollback/);
    assert.equal(await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM "${schema}".jobs WHERE id='rollback'`).then(rows => Number(rows[0].count)), 0);
    await db.$executeRawUnsafe(`INSERT INTO "${schema}".jobs VALUES ('tenant-b','shop-b','same','pending')`);
    await assert.rejects(db.$executeRawUnsafe(`INSERT INTO "${schema}".jobs VALUES ('duplicate','shop-a','same','pending')`), error => String(error).includes("Unique constraint") || String(error).includes("23505"));
    const claim = async () => db.$executeRawUnsafe(`UPDATE "${schema}".jobs SET status='claimed' WHERE id='commit' AND status='pending'`);
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(claims.sort(), [0, 1]);
    assert.equal(await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM "${schema}".jobs WHERE external_id='same'`).then(rows => Number(rows[0].count)), 2);
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
