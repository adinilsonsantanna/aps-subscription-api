import assert from "node:assert/strict";
import test from "node:test";
import { advanceBillingDate, nextRetry } from "../retry-policy";

test("initial failure schedules retry 1 without counting initial attempt", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  assert.deepEqual(nextRetry(0, 3, 2, now), { exhausted: false, nextAttempt: 1, scheduledAt: new Date("2026-08-22T12:00:00.000Z") });
});
test("zero retries exhausts immediately", () => assert.deepEqual(nextRetry(0, 0, 2, new Date(0)), { exhausted: true, nextAttempt: null, scheduledAt: null }));
test("payment and inventory counters are independent inputs", () => { assert.equal(nextRetry(1, 1, 1, new Date(0)).exhausted, true); assert.equal(nextRetry(1, 5, 1, new Date(0)).nextAttempt, 2); });
test("billing date is deterministic", () => assert.equal(advanceBillingDate(new Date("2026-01-31T00:00:00Z"), "week", 2).toISOString(), "2026-02-14T00:00:00.000Z"));
