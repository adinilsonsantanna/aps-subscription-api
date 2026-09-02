import assert from "node:assert/strict";
import test from "node:test";
import { keysFingerprint, sortKeys, unexpectedKeys } from "../keys-fingerprint";

test("sortKeys ordena campos independente da ordem de inserção", () => {
  const first = { a: 1, b: 2, c: 3 };
  const second = { c: 3, a: 1, b: 2 };
  assert.deepEqual(sortKeys(first), ["a", "b", "c"]);
  assert.deepEqual(sortKeys(second), ["a", "b", "c"]);
});

test("fingerprint é determinístico e independe da ordem de inserção", () => {
  const first = { a: 1, b: 2, c: 3 };
  const second = { c: 3, a: 1, b: 2 };
  assert.equal(keysFingerprint(first), keysFingerprint(second));
  assert.match(keysFingerprint(first), /^[0-9a-f]{64}$/);
});

test("adicionar uma key extra altera o fingerprint", () => {
  assert.notEqual(keysFingerprint({ a: 1, b: 2 }), keysFingerprint({ a: 1, b: 2, c: 3 }));
});

test("unexpectedKeys retorna apenas nomes fora da allowlist", () => {
  const accepted = ["a", "b"];
  assert.deepEqual(unexpectedKeys({ a: 1, b: 2, c: "segredo" }, accepted), ["c"]);
  assert.deepEqual(unexpectedKeys({ a: 1 }, accepted), []);
});

test("valores nunca participam do fingerprint, apenas nomes das chaves", () => {
  const one = { token: "segredo-a" };
  const two = { token: "segredo-b" };
  assert.equal(keysFingerprint(one), keysFingerprint(two));
  assert.equal(unexpectedKeys({ token: "segredo-a" }, []).length, 1);
  assert.ok(!JSON.stringify(unexpectedKeys({ token: "segredo-a" }, [])).includes("segredo-a"));
});