import assert from "node:assert/strict";
import test from "node:test";
import app from "../../app";

test("malformed JSON on live endpoint returns sanitized JSON before controller", async () => {
  const previousApiKey = process.env.API_KEY;
  const previousLiveSecret = process.env.ADMIN_RECONCILIATION_LIVE_SECRET;
  process.env.API_KEY = "http-test-api-key";
  process.env.ADMIN_RECONCILIATION_LIVE_SECRET = "http-test-live-secret";
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/administrative-reconciliation/billing-attempt/live`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "http-test-api-key",
        "x-admin-live-key": "http-test-live-secret",
      },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type") || "", /application\/json/i);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: "invalid_json" });
    for (const forbidden of ["<html", "SyntaxError", "stack", "Unexpected end", 'body: "{"']) assert.equal(text.includes(forbidden), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousApiKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = previousApiKey;
    if (previousLiveSecret === undefined) delete process.env.ADMIN_RECONCILIATION_LIVE_SECRET; else process.env.ADMIN_RECONCILIATION_LIVE_SECRET = previousLiveSecret;
  }
});
