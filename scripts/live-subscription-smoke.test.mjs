import assert from "node:assert/strict";
import test from "node:test";
import { planLiveSmoke } from "./live-subscription-smoke.mjs";

const uuid = () => "00000000-0000-4000-8000-000000000009";
test("ordinary CI and disabled execution stay blocked without importing mutation code", () => { const plan = planLiveSmoke({ CI: "true" }, uuid); assert.deepEqual(plan.blockers.slice(0, 2), ["disabled", "ordinary_ci_forbidden"]); assert.equal(plan.mode, "dry-run"); });
test("Betterlife is refused by domain shopId and aliases", () => { for (const env of [{ LIVE_SUBSCRIPTION_TEST_SHOP: "betterlife.myshopify.com" }, { LIVE_SUBSCRIPTION_TEST_SHOP_ID: "gid://shopify/Shop/Betterlife" }, { LIVE_SUBSCRIPTION_TEST_SHOP_ALIASES: "dev,betterlife-store" }]) assert.ok(planLiveSmoke({ ENABLE_LIVE_SUBSCRIPTION_TESTS: "true", ...env }, uuid).blockers.includes("betterlife_forbidden")); });
test("test gateway allowlist and separate mutable confirmations are mandatory", () => { const base = { ENABLE_LIVE_SUBSCRIPTION_TESTS: "true", LIVE_SUBSCRIPTION_TEST_SHOP: "scope9-dev.myshopify.com", LIVE_SUBSCRIPTION_TEST_ALLOWLIST: "scope9-dev.myshopify.com", LIVE_SUBSCRIPTION_TEST_GATEWAY: "shopify-test" }; const plan = planLiveSmoke(base, uuid); assert.deepEqual(plan.blockers, ["step_confirmation_required"]); assert.equal(plan.confirmations.length, 3); assert.ok(plan.resources.every(item => JSON.stringify(item.cleanupWhere) === JSON.stringify({ correlationId: plan.correlationId }))); });
test("missing test gateway is refused and each plan has a unique correlationId", () => { assert.ok(planLiveSmoke({ ENABLE_LIVE_SUBSCRIPTION_TESTS: "true" }, uuid).blockers.includes("test_gateway_required")); assert.notEqual(planLiveSmoke({}, () => "a").correlationId, planLiveSmoke({}, () => "b").correlationId); });
