import assert from "node:assert/strict";
import test from "node:test";
import { ResendWebhookController } from "../ResendWebhookController";

function response() { const state = { status: 200, body: undefined as unknown }; return { state, value: { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } } }; }
test("Express Resend route passes the exact raw body and Svix signature headers", async () => { const raw = Buffer.from('{"type":"domain.updated"}'), received: { raw?: string; headers?: unknown } = {}; const controller = new ResendWebhookController({ handle: async (body: string, headers: unknown) => { received.raw = body; received.headers = headers; return { processed: true }; } } as never), output = response(); await controller.handle({ body: raw, headers: { "svix-id": "evt", "svix-timestamp": "1", "svix-signature": "sig" } } as never, output.value as never); assert.equal(received.raw, raw.toString("utf8")); assert.deepEqual(received.headers, { id: "evt", timestamp: "1", signature: "sig" }); assert.equal(output.state.status, 200); });
