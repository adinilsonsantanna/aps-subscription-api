import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

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

live("administrative reconciliation rolls back Order failure, Audit failure, and serializes concurrent live requests", async () => {
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) throw new Error("TEST_DATABASE_URL must be an isolated PostgreSQL URL");
  if (process.env.DATABASE_URL && url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must not equal DATABASE_URL");
  const schema = `scope9_live_${process.pid}_${Date.now()}`;
  if (!/^scope9_live_\d+_\d+$/.test(schema)) throw new Error("unsafe test schema name");
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".attempts (id text PRIMARY KEY, status text NOT NULL, reconciliation_status text NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".orders (id text PRIMARY KEY, amount numeric(10,2) NOT NULL, status text NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}".audits (billing_attempt_id text PRIMARY KEY, payload_hash text NOT NULL CHECK (length(payload_hash) > 0))`);
    const reset = async () => {
      await db.$executeRawUnsafe(`TRUNCATE "${schema}".audits`);
      await db.$executeRawUnsafe(`TRUNCATE "${schema}".attempts, "${schema}".orders`);
      await db.$executeRawUnsafe(`INSERT INTO "${schema}".attempts VALUES ('attempt-1','succeeded','pending')`);
      await db.$executeRawUnsafe(`INSERT INTO "${schema}".orders VALUES ('order-1',0,'PAID')`);
    };
    const state = async () => ({
      attempt: await db.$queryRawUnsafe<Array<{ reconciliation_status: string }>>(`SELECT reconciliation_status FROM "${schema}".attempts WHERE id='attempt-1'`),
      order: await db.$queryRawUnsafe<Array<{ amount: unknown }>>(`SELECT amount FROM "${schema}".orders WHERE id='order-1'`),
      audits: await db.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM "${schema}".audits`),
    });

    await reset();
    await assert.rejects(db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`UPDATE "${schema}".attempts SET reconciliation_status='complete' WHERE id='attempt-1'`);
      await tx.$executeRawUnsafe(`UPDATE "${schema}".orders SET amount='invalid-number' WHERE id='order-1'`);
    }));
    let after = await state();
    assert.equal(after.attempt[0].reconciliation_status, "pending");
    assert.equal(String(after.order[0].amount), "0");
    assert.equal(Number(after.audits[0].count), 0);

    await reset();
    await assert.rejects(db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`UPDATE "${schema}".attempts SET reconciliation_status='complete' WHERE id='attempt-1'`);
      await tx.$executeRawUnsafe(`UPDATE "${schema}".orders SET amount=50.19 WHERE id='order-1'`);
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}".audits VALUES ('attempt-1','')`);
    }));
    after = await state();
    assert.equal(after.attempt[0].reconciliation_status, "pending");
    assert.equal(String(after.order[0].amount), "0");
    assert.equal(Number(after.audits[0].count), 0);

    await reset();
    const reconcile = async (): Promise<string> => {
      for (let retry = 1; retry <= 3; retry += 1) {
        try {
          return await db.$transaction(async tx => {
            const audit = await tx.$queryRawUnsafe<Array<{ payload_hash: string }>>(`SELECT payload_hash FROM "${schema}".audits WHERE billing_attempt_id='attempt-1'`);
            if (audit.length) return audit[0].payload_hash === "same-hash" ? "already_reconciled" : "conflict";
            await tx.$executeRawUnsafe(`UPDATE "${schema}".attempts SET reconciliation_status='complete' WHERE id='attempt-1'`);
            await tx.$executeRawUnsafe(`UPDATE "${schema}".orders SET amount=50.19 WHERE id='order-1'`);
            await tx.$executeRawUnsafe(`INSERT INTO "${schema}".audits VALUES ('attempt-1','same-hash')`);
            return "reconciled";
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
          if (retry === 3) throw error;
        }
      }
      throw new Error("unreachable");
    };
    const results = await Promise.all([reconcile(), reconcile()]);
    assert.deepEqual(results.sort(), ["already_reconciled", "reconciled"]);
    after = await state();
    assert.equal(after.attempt[0].reconciliation_status, "complete");
    assert.equal(String(after.order[0].amount), "50.19");
    assert.equal(Number(after.audits[0].count), 1);
  } finally {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
