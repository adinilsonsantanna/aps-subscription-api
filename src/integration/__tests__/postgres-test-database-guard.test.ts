import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertSafePostgresTestDatabaseUrl } from "../postgres-test-database-guard";

const valid = "postgresql://test-user:test-password@test-db.example.test/aps_subscription_test";

function rejects(testUrl: string | undefined, databaseUrl?: string) {
  assert.throws(
    () => assertSafePostgresTestDatabaseUrl(testUrl, databaseUrl),
    (error: unknown) => error instanceof Error
      && error.message.startsWith("Unsafe PostgreSQL test database:")
      && !error.message.includes("test-password")
      && !error.message.includes("production-password"),
  );
}

test("database guard accepts an isolated temporary PostgreSQL test destination", () => {
  assert.equal(assertSafePostgresTestDatabaseUrl(valid, undefined), valid);
  for (const database of ["aps_subscription_test", "test_aps", "APS_TEST_DB"]) {
    const url = `postgresql://test-db.example.test/${database}`;
    assert.equal(assertSafePostgresTestDatabaseUrl(url, undefined), url);
  }
});

test("database guard requires TEST_DATABASE_URL and rejects malformed or non-PostgreSQL URLs", () => {
  rejects(undefined);
  rejects("not-a-url");
  rejects("https://test-db.example.test/aps_subscription_test");
  rejects("postgresql://test-db.example.test/aps_subscription_test%ZZ");
});

test("database guard rejects unsafe database and hostname names", () => {
  for (const database of [
    "PRODUCTION_test",
    "aps_Prod_test",
    "main_test",
    "aps_test_prod",
    "subscriptions",
    "contest",
    "latest",
  ]) {
    rejects(`postgresql://test-db.example.test/${database}`);
  }
  rejects("postgresql://production-db.example.test/aps_subscription_test");
  rejects("postgresql://main.example.test/aps_subscription_test");
});

test("database guard rejects every character outside the strict ASCII allowlist", () => {
  const unsafeDatabases = [
    "",
    "aps_test\0name",
    "aps_test%00name",
    "aps_test name",
    "aps_test%20name",
    "aps_test\tname",
    "aps_test%09name",
    "aps_test\nname",
    "aps_test%0Aname",
    "aps_test\rname",
    "aps_test%0Dname",
    "aps_test%01name",
    "aps_test/name",
    "aps_test%2Fname",
    "aps_test\\name",
    "aps_test%5Cname",
    "aps_test%name",
    "aps_test%2500name",
    "aps_tést",
    "aps_test-name",
    "aps_test.name",
    "aps_test$name",
  ];

  for (const database of unsafeDatabases) {
    rejects(`postgresql://test-db.example.test/${database}`);
  }
});

test("database guard compares canonical destinations instead of raw URL text", () => {
  const variants = [
    valid,
    "postgresql://test-user:production-password@test-db.example.test/aps_subscription_test",
    "postgresql://test-user:test-password@test-db.example.test/aps_subscription_test?schema=other#fragment",
    "postgresql://test-user:test-password@TEST-DB.EXAMPLE.TEST./aps_subscription_test",
    "postgresql://test-user:test-password@test-db.example.test:5432/aps_subscription_test",
    "postgresql://test-user:test-password@test-db.example.test/aps_subscription_%74est",
  ];
  for (const productionUrl of variants) rejects(valid, productionUrl);
});

test("database guard errors never expose URLs or credentials", () => {
  const secret = "production-password";
  assert.throws(
    () => assertSafePostgresTestDatabaseUrl(
      `postgresql://user:${secret}@prod.example.test/aps_subscription_test?sslmode=require`,
      undefined,
    ),
    (error: unknown) => error instanceof Error
      && !error.message.includes(secret)
      && !error.message.includes("sslmode")
      && !error.message.includes("postgresql://"),
  );

  const dangerousInput = "aps_test%00secret-fragment";
  assert.throws(
    () => assertSafePostgresTestDatabaseUrl(
      `postgresql://user:${secret}@test-db.example.test/${dangerousInput}`,
      undefined,
    ),
    (error: unknown) => error instanceof Error
      && error.message.startsWith("Unsafe PostgreSQL test database:")
      && !error.message.includes(secret)
      && !error.message.includes(dangerousInput)
      && !error.message.includes("secret-fragment"),
  );
});

test("database guard runs before the harness can construct PrismaClient", () => {
  const harness = readFileSync(
    "src/integration/__tests__/postgres-transaction.integration.test.ts",
    "utf8",
  );
  const guardCall = harness.indexOf("assertSafePostgresTestDatabaseUrl(process.env.TEST_DATABASE_URL");
  const prismaConstruction = harness.indexOf("new PrismaClient(");

  assert.notEqual(guardCall, -1);
  assert.notEqual(prismaConstruction, -1);
  assert.ok(guardCall < prismaConstruction);
});
