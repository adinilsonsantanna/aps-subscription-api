import assert from "node:assert/strict";
import test from "node:test";
import { adminLiveAuth } from "../adminLiveAuth";

function request(header?: string) {
  const headers: Record<string, string> = {};
  if (header !== undefined) headers["x-admin-live-key"] = header;
  return { headers };
}

function response() {
  const state = { status: 200, body: undefined as unknown };
  return { state, value: { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } } };
}

function next() { (next as any).called = true; }

test("live auth is fail-closed when no live secret is configured", async () => {
  const previous = process.env.ADMIN_RECONCILIATION_LIVE_SECRET;
  delete process.env.ADMIN_RECONCILIATION_LIVE_SECRET;
  try {
    const output = response();
    adminLiveAuth(request("anything") as any, output.value as any, next as any);
    assert.equal(output.state.status, 403);
    assert.deepEqual(output.state.body, { error: "live_authorization_required" });
    assert.equal((next as any).called, undefined);
  } finally {
    if (previous !== undefined) process.env.ADMIN_RECONCILIATION_LIVE_SECRET = previous;
  }
});

test("live auth rejects missing and wrong live key with 403 and no next", async () => {
  process.env.ADMIN_RECONCILIATION_LIVE_SECRET = "live-secret-value";
  try {
    for (const header of [undefined, "", "wrong-live-secret"]) {
      const output = response();
      delete (next as any).called;
      adminLiveAuth(request(header) as any, output.value as any, next as any);
      assert.equal(output.state.status, 403);
      assert.equal((next as any).called, undefined);
    }
  } finally {
    delete process.env.ADMIN_RECONCILIATION_LIVE_SECRET;
  }
});

test("live auth accepts matching live key and calls next", async () => {
  process.env.ADMIN_RECONCILIATION_LIVE_SECRET = "live-secret-value";
  try {
    const output = response();
    delete (next as any).called;
    adminLiveAuth(request("live-secret-value") as any, output.value as any, next as any);
    assert.equal(output.state.status, 200);
    assert.equal((next as any).called, true);
  } finally {
    delete process.env.ADMIN_RECONCILIATION_LIVE_SECRET;
  }
});
