import assert from "node:assert/strict";
import test from "node:test";
import { billingRetryJobKey } from "../../retry/RetryEngineService";
import { advanceBillingDate } from "../../retry/retry-policy";
import { canonicalBillingSourceKey } from "../../notifications/billing-notification-identity";
import { renderNotification } from "../../notifications/notification-template";
import { ResendWebhookService } from "../../notifications/ResendWebhookService";
import { ShopifyEventIngestionService } from "../../shopify/events/shopify-event.service";

test("production modules preserve one correlation chain from first order through delivered renewal", async () => {
  const correlationId = "scope9:shop-a:cycle-2026-08";
  const state: any = { events: new Map(), subscriptions: new Map(), lines: new Map() };
  const repository: any = {
    findShopByDomain: async (domain: string) => domain === "shop-a.myshopify.com" ? { id: "shop-a", isActive: true } : null,
    findEventById: async (id: string) => state.events.get(id) ?? null,
    createEvent: async (event: any) => state.events.set(event.webhookId, { processed: false, event }),
    processEvent: async (event: any) => {
      const contract = event.contract;
      state.subscriptions.set(contract.id, { shopId: "shop-a", contractId: contract.id, orderId: contract.originOrder.id, nextBillingAt: contract.nextBillingAt });
      state.lines.set(contract.id, contract.lines);
      state.events.set(event.webhookId, { processed: true, event });
    },
    markEventFailed: async (id: string, error: string) => state.events.set(id, { processed: false, error }),
  };
  const service = new ShopifyEventIngestionService(repository);
  const input: any = { shop: "shop-a.myshopify.com", topic: "subscription_contracts/create", webhookId: `${correlationId}:webhook:first`, shopifyEventId: `${correlationId}:event:first`, receivedAt: "2026-08-31T12:00:00.000Z", payload: { admin_graphql_api_id: "gid://shopify/SubscriptionContract/9" }, contract: { id: "gid://shopify/SubscriptionContract/9", revisionId: "revision-1", status: "ACTIVE", nextBillingAt: "2026-08-31T12:00:00.000Z", currencyCode: "BRL", originOrder: { id: "gid://shopify/Order/initial", amount: "99.90", currencyCode: "BRL", financialStatus: "PAID" }, customer: { id: "gid://shopify/Customer/9", email: "customer@example.test" }, billingPolicy: { interval: "MONTH", intervalCount: 1 }, deliveryPolicy: { interval: "MONTH", intervalCount: 1 }, lines: [{ id: "gid://shopify/SubscriptionLine/9", productId: "gid://shopify/Product/9", variantId: "gid://shopify/ProductVariant/9", sellingPlanId: "gid://shopify/SellingPlan/9", quantity: 2, currentPrice: { amount: "49.95", currencyCode: "BRL" } }] } };
  await service.ingest(input);
  assert.deepEqual(await service.ingest(input), { duplicate: true, processed: true });
  const jobKey = billingRetryJobKey("shop-a", correlationId, "PAYMENT" as never, 0);
  const attemptId = "gid://shopify/SubscriptionBillingAttempt/9", recurringOrderId = "gid://shopify/Order/recurring";
  const sourceKey = canonicalBillingSourceKey({ shopifyBillingAttemptId: attemptId, idempotencyKey: jobKey, shopifyContractId: input.contract.id, billingCycleAt: new Date(input.contract.nextBillingAt) });
  const nextBillingAt = advanceBillingDate(new Date(input.contract.nextBillingAt), "month", 1);
  const notification = renderNotification("renewal_succeeded", { subscriptionId: input.contract.id, orderId: recurringOrderId, amount: "99.90", currency: "BRL" });
  const outbox: any = { id: `${correlationId}:outbox`, shopId: "shop-a", idempotencyKey: sourceKey, providerMessageId: "provider-message-9", status: "sent" };
  const deliveryEvents = new Map<string, any>();
  const deliveryDb: any = { notificationDeliveryEvent: { findUnique: async ({ where }: any) => deliveryEvents.get(where.providerEventId) ?? null, create: async ({ data }: any) => { if (deliveryEvents.has(data.providerEventId)) throw Object.assign(new Error("duplicate"), { code: "P2002" }); deliveryEvents.set(data.providerEventId, data); return data; } }, notificationOutbox: { findUnique: async ({ where }: any) => where.providerMessageId === outbox.providerMessageId ? outbox : null, update: async ({ data }: any) => Object.assign(outbox, data) }, $transaction: async (callback: any) => callback(deliveryDb) };
  const previousSecret = process.env.RESEND_WEBHOOK_SECRET; process.env.RESEND_WEBHOOK_SECRET = "whsec_scope9";
  try { const delivered = await new ResendWebhookService(deliveryDb, { webhooks: { verify: () => ({ id: `${correlationId}:resend:delivered`, type: "email.delivered", created_at: "2026-08-31T12:01:00.000Z", data: { email_id: outbox.providerMessageId } }) } } as never, {} as never).handle("{}", { id: "signed-event", timestamp: "1", signature: "signature" }); assert.deepEqual(delivered, { processed: true }); } finally { if (previousSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET; else process.env.RESEND_WEBHOOK_SECRET = previousSecret; }
  assert.equal(state.subscriptions.get(input.contract.id).orderId, "gid://shopify/Order/initial");
  assert.equal(state.lines.get(input.contract.id)[0].sellingPlanId, "gid://shopify/SellingPlan/9");
  assert.match(jobKey, new RegExp(correlationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sourceKey, /SubscriptionBillingAttempt\/9|attempt/i);
  assert.equal(nextBillingAt.toISOString(), "2026-09-30T12:00:00.000Z");
  assert.match(notification.html, /99/);
  assert.equal(outbox.status, "delivered");
  assert.equal(deliveryEvents.size, 1);
  assert.equal(outbox.idempotencyKey, sourceKey);
  assert.ok(attemptId && recurringOrderId && notification.subject);
});
