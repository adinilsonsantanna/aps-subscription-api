import assert from "node:assert/strict";
import test from "node:test";
import { RETRY_DEFAULTS, validateRetrySettings } from "../retry-settings";
test("preserves documented defaults", () => { assert.equal(RETRY_DEFAULTS.paymentRetryAttempts, 3); assert.equal(RETRY_DEFAULTS.inventoryRetryAttempts, 5); });
test("accepts limits", () => assert.equal(validateRetrySettings({ ...RETRY_DEFAULTS, paymentRetryAttempts: 0, inventoryRetryAttempts: 10 }).inventoryRetryAttempts, 10));
test("rejects invalid limits and enums", () => { assert.throws(() => validateRetrySettings({ ...RETRY_DEFAULTS, paymentRetryDays: 15 })); assert.throws(() => validateRetrySettings({ ...RETRY_DEFAULTS, paymentFailureAction: "DELETE" })); });
