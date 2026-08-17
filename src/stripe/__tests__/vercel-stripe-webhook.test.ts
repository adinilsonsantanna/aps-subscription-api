import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import Stripe from "stripe";
import { createStripeWebhookHandler } from "../../../api/webhooks/stripe";

function request(chunks: Buffer[], signature?: string) { const stream = Readable.from(chunks) as any; stream.method = "POST"; stream.headers = signature ? { "stripe-signature": signature } : {}; return stream; }
function response() { const state = { status: 0, body: undefined as unknown }; return { state, value: { status(code: number) { state.status = code; return this; }, json(body: unknown) { state.body = body; return this; } } }; }
const secret = "whsec_test_scope_6";
const stripe = new Stripe("sk_test_placeholder", { apiVersion: "2025-02-24.acacia" });
const raw = Buffer.from('{"id":"evt_legitimate","type":"customer.subscription.updated","created":100,"data":{"object":{"id":"sub_1","status":"active","object":"subscription"}},"object":"event"}', "utf8");
const signature = Stripe.webhooks.generateTestHeaderString({ payload: raw.toString("utf8"), secret });

function handler(timeout = 100) { let received: Buffer | undefined; let processed = 0; return { get received() { return received; }, get processed() { return processed; }, value: createStripeWebhookHandler({ constructEvent: (body, header) => { received = body; return stripe.webhooks.constructEvent(body, header, secret); }, process: async () => { processed += 1; return { processed: true }; }, rawBodyTimeoutMs: timeout }) }; }

test("Vercel handler accepts a legitimate signature and verifies the exact received bytes", async () => { const target = handler(); const output = response(); await target.value(request([raw.subarray(0, 17), raw.subarray(17)], signature), output.value as never); assert.equal(output.state.status, 200); assert.deepEqual(target.received, raw); assert.equal(target.processed, 1); });
test("Vercel handler rejects an altered body", async () => { const target = handler(); const output = response(); const altered = Buffer.from(raw); altered[10] ^= 1; await target.value(request([altered], signature), output.value as never); assert.equal(output.state.status, 400); assert.equal(target.processed, 0); });
test("Vercel handler rejects a missing signature without reading or processing", async () => { const target = handler(); const output = response(); await target.value(request([raw]), output.value as never); assert.equal(output.state.status, 400); assert.equal(target.processed, 0); });
test("Vercel handler times out instead of waiting indefinitely for an unfinished body", async () => { const target = handler(15); const stream = new Readable({ read() {} }) as any; stream.method = "POST"; stream.headers = { "stripe-signature": signature }; const output = response(); const started = Date.now(); await target.value(stream, output.value as never); assert.equal(output.state.status, 400); assert.ok(Date.now() - started < 250); assert.equal(target.processed, 0); stream.destroy(); });
