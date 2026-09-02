import assert from "node:assert/strict";
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
});

test("database guard requires TEST_DATABASE_URL and rejects malformed or non-PostgreSQL URLs", () => {
  rejects(undefined);
  rejects("not-a-url");
  rejects("https://test-db.example.test/aps_subscription_test");
  rejects("postgresql://test-db.example.test/aps_subscription_test%ZZ");
});

test("database guard rejects unsafe database and hostname names", () => {
  for (const database of ["PRODUCTION_test", "aps_Prod_test", "main_test", "subscriptions"]) {
    rejects(`postgresql://test-db.example.test/${database}`);
  }
  rejects("postgresql://production-db.example.test/aps_subscription_test");
  rejects("postgresql://main.example.test/aps_subscription_test");
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
});
