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

test("unexpectedKeys devolve nomes fora da allowlist como marcador fixo", () => {
  const accepted = ["a", "b"];
  assert.deepEqual(unexpectedKeys({ a: 1, b: 2, c: "segredo" }, accepted), [INVALID_KEY_NAME_MARKER]);
  assert.deepEqual(unexpectedKeys({ a: 1 }, accepted), []);
});

test("valores nunca participam do fingerprint, apenas nomes das chaves", () => {
  const one = { token: "segredo-a" };
  const two = { token: "segredo-b" };
  assert.equal(keysFingerprint(one), keysFingerprint(two));
  assert.equal(unexpectedKeys(one, []).length, 1);
  assert.deepEqual(unexpectedKeys(one, []), [INVALID_KEY_NAME_MARKER]);
  assert.ok(!JSON.stringify(unexpectedKeys(one, [])).includes("segredo-a"));
});

test("secret ou PII embutido em nome sintaticamente não aparece", () => {
  for (const secret of ["apiKey-super-secret-value", "cpf12345678900", "email-user-example.com"]) {
    const output = unexpectedKeys({ [secret]: 1 }, []);
    assert.deepEqual(output, [INVALID_KEY_NAME_MARKER], `esperado marcador para ${JSON.stringify(secret)}`);
    assert.ok(!JSON.stringify(output).includes(secret));
  }
});

test("nomes de diagnose permitidos permanecem visíveis", () => {
  assert.deepEqual(unexpectedKeys({ confirmation: 1 }, []), ["confirmation"]);
  assert.deepEqual(unexpectedKeys({ confirmationMessage: 2 }, []), ["confirmationMessage"]);
  assert.deepEqual(unexpectedKeys({ shop: 3, requestId: 4, billingAttemptId: 5 }, []), ["billingAttemptId", "requestId", "shop"]);
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
  assert.equal(output.every((entry) => entry === INVALID_KEY_NAME_MARKER), true);
});

test("fingerprint representa o conjunto original completo de chaves ordenadas", () => {
  const valueA = { c: 3, a: 1, b: 2 };
  const valueB = { a: 1, b: 2, c: 3 };
  assert.equal(keysFingerprint(valueA), keysFingerprint(valueB));
  assert.notEqual(keysFingerprint({ a: 1 }), keysFingerprint({ a: 1, "weird\nkey": 2 }));
});