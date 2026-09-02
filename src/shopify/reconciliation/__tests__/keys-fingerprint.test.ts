import assert from "node:assert/strict";
import test from "node:test";
import { keysFingerprint, sortKeys, unexpectedKeys, INVALID_KEY_NAME_MARKER, MAX_LOGGED_UNEXPECTED_KEYS } from "../keys-fingerprint";

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

test("key com segredo no próprio nome é substituída por marcador fixo", () => {
  const output = unexpectedKeys({ "apiKey=super-secret-value": 1 }, []);
  assert.deepEqual(output, [INVALID_KEY_NAME_MARKER]);
  assert.ok(!JSON.stringify(output).includes("super-secret-value"));
  assert.ok(!JSON.stringify(output).includes("apiKey"));
});

test("names com newline, controle ou unicode são substituídos por marcador fixo", () => {
  for (const bad of ["na\x00me", "na\x1fme", "na\nme", "na\rme", "cam\u00e3o"]) {
    const output = unexpectedKeys({ [bad]: 1 }, []);
    assert.deepEqual(output, [INVALID_KEY_NAME_MARKER], `esperado marcador para ${JSON.stringify(bad)}`);
    assert.ok(!JSON.stringify(output).includes(bad));
  }
});

test("nome acima de 80 caracteres é substituído por marcador fixo", () => {
  const long = "k".repeat(81);
  const output = unexpectedKeys({ [long]: 1 }, []);
  assert.deepEqual(output, [INVALID_KEY_NAME_MARKER]);
  assert.ok(!JSON.stringify(output).includes("k".repeat(81)));
});

test("mais de 20 chaves desconhecidas registra no máximo 20", () => {
  const value: Record<string, number> = {};
  for (let i = 0; i < 30; i += 1) value[`key_${i}`] = i;
  const output = unexpectedKeys(value, []);
  assert.equal(output.length, MAX_LOGGED_UNEXPECTED_KEYS);
  assert.equal(output.length, 20);
  assert.equal(new Set(output).size, 20);
});

test("fingerprint representa o conjunto original completo de chaves ordenadas", () => {
  const valueA = { c: 3, a: 1, b: 2 };
  const valueB = { a: 1, b: 2, c: 3 };
  assert.equal(keysFingerprint(valueA), keysFingerprint(valueB));
  assert.notEqual(keysFingerprint({ a: 1 }), keysFingerprint({ a: 1, "weird\nkey": 2 }));
});