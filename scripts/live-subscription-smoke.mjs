const enabled = process.env.ENABLE_LIVE_SUBSCRIPTION_TESTS === "true";
const shop = String(process.env.LIVE_SUBSCRIPTION_TEST_SHOP || "").toLowerCase();
const allowlist = new Set(String(process.env.LIVE_SUBSCRIPTION_TEST_ALLOWLIST || "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean));
const gateway = String(process.env.LIVE_SUBSCRIPTION_TEST_GATEWAY || "").toLowerCase();
const forbidden = /betterlife/i.test(shop);

console.log(JSON.stringify({ mode: "dry-run", enabled, shop: shop || null, gateway: gateway || null, plan: ["create uniquely tagged fixture", "exercise one development-store subscription cycle", "collect correlation IDs", "delete only records carrying the fixture tag"] }, null, 2));
if (!enabled) process.exit(0);
if (!shop || !allowlist.has(shop)) throw new Error("Live smoke refused: development shop must be explicitly allowlisted");
if (forbidden) throw new Error("Live smoke refused: Betterlife domains are forbidden");
if (!["stripe-test", "shopify-test"].includes(gateway)) throw new Error("Live smoke refused: a test gateway is required");
console.log("Dry-run only. No external mutation was executed.");
