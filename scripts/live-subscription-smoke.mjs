import { randomUUID } from "node:crypto";

export function planLiveSmoke(env = process.env, uuid = randomUUID) {
  const enabled = env.ENABLE_LIVE_SUBSCRIPTION_TESTS === "true", ci = env.CI === "true";
  const shop = String(env.LIVE_SUBSCRIPTION_TEST_SHOP || "").trim().toLowerCase();
  const shopId = String(env.LIVE_SUBSCRIPTION_TEST_SHOP_ID || "").trim().toLowerCase();
  const aliases = String(env.LIVE_SUBSCRIPTION_TEST_SHOP_ALIASES || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const allowlist = new Set(String(env.LIVE_SUBSCRIPTION_TEST_ALLOWLIST || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  const gateway = String(env.LIVE_SUBSCRIPTION_TEST_GATEWAY || "").toLowerCase();
  const correlationId = `scope9-${uuid()}`;
  const forbiddenIdentity = [shop, shopId, ...aliases].some(value => value.includes("betterlife"));
  const confirmations = ["CREATE_FIXTURE", "BILL_TEST_GATEWAY", "CLEANUP_FIXTURE"].map(step => ({ step, confirmed: env[`CONFIRM_LIVE_${step}`] === correlationId }));
  const resources = ["subscription", "billingRetryCycle", "billingRetryJob", "subscriptionOrder", "notificationOutbox"].map(type => ({ type, createTag: correlationId, cleanupWhere: { correlationId } }));
  const blockers = [!enabled && "disabled", ci && "ordinary_ci_forbidden", (!shop || !allowlist.has(shop)) && "shop_not_allowlisted", forbiddenIdentity && "betterlife_forbidden", !["stripe-test", "shopify-test"].includes(gateway) && "test_gateway_required", confirmations.some(item => !item.confirmed) && "step_confirmation_required"].filter(Boolean);
  return { mode: "dry-run", enabled, correlationId, shop: shop || null, shopId: shopId || null, aliases, gateway: gateway || null, confirmations, resources, blockers };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) console.log(JSON.stringify(planLiveSmoke(), null, 2));
