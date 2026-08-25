import { canonicalizeShopId } from '../shopId';
import { test } from 'node:test';
import assert from 'node:assert';

test("canonicalizes numeric ID", () => {
    assert.strictEqual(canonicalizeShopId("100264018283"), "gid://shopify/Shop/100264018283");
});

test("canonicalizes GID", () => {
    assert.strictEqual(canonicalizeShopId("gid://shopify/Shop/100264018283"), "gid://shopify/Shop/100264018283");
});

test("preserves numeric IDs above Number.MAX_SAFE_INTEGER without precision loss", () => {
    const shopId = "900719925474099312345678901234567890";
    assert.strictEqual(canonicalizeShopId(shopId), `gid://shopify/Shop/${shopId}`);
});

test("rejects invalid IDs", () => {
    assert.throws(() => canonicalizeShopId("gid://shopify/Product/123"));
    assert.throws(() => canonicalizeShopId("0"));
    assert.throws(() => canonicalizeShopId("-1"));
    assert.throws(() => canonicalizeShopId("1.2"));
    assert.throws(() => canonicalizeShopId(""));
});
