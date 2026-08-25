import { canonicalizeShopId } from '../shopId';
import { test } from 'node:test';
import assert from 'node:assert';

test("canonicalizes numeric ID", () => {
    assert.strictEqual(canonicalizeShopId("100264018283"), "gid://shopify/Shop/100264018283");
});

test("canonicalizes GID", () => {
    assert.strictEqual(canonicalizeShopId("gid://shopify/Shop/100264018283"), "gid://shopify/Shop/100264018283");
});

test("rejects invalid IDs", () => {
    assert.throws(() => canonicalizeShopId("gid://shopify/Product/123"));
    assert.throws(() => canonicalizeShopId("0"));
    assert.throws(() => canonicalizeShopId("-1"));
    assert.throws(() => canonicalizeShopId("1.2"));
    assert.throws(() => canonicalizeShopId(""));
});
