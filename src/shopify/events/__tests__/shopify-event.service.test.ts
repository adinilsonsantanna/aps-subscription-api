import test from "node:test";
import assert from "node:assert/strict";
import { apiAuth, secureApiKeyMatches } from "../../../middlewares/apiAuth";
import {
  ShopifyEventRepository,
  billingAttemptDataFromPayload,
  contractPatchFromPayload,
  contractUpdatePatch,
  newShopifySubscriptionData,
} from "../shopify-event.repository";
import { ShopifyEventIngestionService } from "../shopify-event.service";
import {
  IncomingShopifyEvent,
  NormalizedShopifyContract,
  ShopifyEventPayload,
  ShopifyShopNotFoundError,
  contractIdFromPayload,
  optionalString,
} from "../shopify-event.types";

class MemoryRepository implements ShopifyEventRepository {
  shops = new Map<string, { id: string; isActive: boolean; shopifyShopId?: string }>([["known.myshopify.com", { id: "shop-1", isActive: true }]]);
  events = new Map<string, { processed: boolean; processedAt?: Date; errorMessage?: string; shopifyEventId?: string }>();
  contracts = new Map<string, Partial<ReturnType<typeof contractPatchFromPayload>> & { shopifyRevisionId?: string; shopifyProductId?: string; shopifyVariantId?: string }>();
  lines = new Map<string, Map<string, { quantity: number; currentPrice: string; isActive: boolean; sellingPlanId?: string }>>();
  attempts: Array<ReturnType<typeof billingAttemptDataFromPayload> & { webhookEventId: string }> = [];
  processCount = 0;
  failNextProcessing = false;

  async findShopByDomain(domain: string) {
    return this.shops.get(domain) ?? null;
  }

  async findEventById(eventId: string) {
    return this.events.get(eventId) ?? null;
  }

  async createEvent(event: IncomingShopifyEvent) {
    this.events.set(event.webhookId, { processed: false, shopifyEventId: event.shopifyEventId });
  }

  async processEvent(event: IncomingShopifyEvent) {
    this.processCount += 1;
    if (this.failNextProcessing) {
      this.failNextProcessing = false;
      throw new Error("transient failure");
    }

    if (event.shopifyShopId) this.shops.set(event.shop, { ...this.shops.get(event.shop)!, shopifyShopId: event.shopifyShopId });
    if (event.topic === "subscription_contracts/create") {
      const id = optionalString(event.payload, "admin_graphql_api_id");
      if (!id) throw new Error("missing contract");
      this.contracts.set(id, contractPatchFromPayload(event.payload));
    } else if (event.topic === "subscription_contracts/update") {
      const id = optionalString(event.payload, "admin_graphql_api_id");
      if (!id) throw new Error("missing contract");
      const current = this.contracts.get(id) ?? {};
      const patch = Object.fromEntries(
        Object.entries(contractPatchFromPayload(event.payload)).filter(([, value]) => value !== undefined),
      );
      this.contracts.set(id, { ...current, ...patch });
    } else if (
      event.topic === "subscription_billing_attempts/success" ||
      event.topic === "subscription_billing_attempts/failure" ||
      event.topic === "subscription_billing_attempts/challenged"
    ) {
      const contractId = contractIdFromPayload(event.payload);
      if (!contractId) throw new Error("missing contract");
      if (!this.contracts.has(contractId)) this.contracts.set(contractId, {});
      const attempt = {
        ...billingAttemptDataFromPayload(event.topic, event.payload),
        webhookEventId: event.webhookId,
      };
      const existingAttempt = this.attempts.findIndex(
        (candidate) => candidate.webhookEventId === event.webhookId,
      );
      if (existingAttempt >= 0) this.attempts[existingAttempt] = attempt;
      else this.attempts.push(attempt);
    } else if (event.topic === "app/uninstalled") {
      this.shops.set(event.shop, { id: "shop-1", isActive: false });
    }
    if (event.contract) {
      const currentLines = this.lines.get(event.contract.id) ?? new Map();
      const incoming = new Set(event.contract.lines.map((line) => line.id));
      for (const [id, line] of currentLines) if (!incoming.has(id)) currentLines.set(id, { ...line, isActive: false });
      for (const line of event.contract.lines) currentLines.set(line.id, { quantity: line.quantity, currentPrice: line.currentPrice.amount, isActive: true, ...(line.sellingPlanId && { sellingPlanId: line.sellingPlanId }) });
      this.lines.set(event.contract.id, currentLines);
      const stored = this.contracts.get(event.contract.id) ?? {};
      this.contracts.set(event.contract.id, { ...stored, ...(event.contract.revisionId && { shopifyRevisionId: event.contract.revisionId }), shopifyProductId: event.contract.lines[0]?.productId, shopifyVariantId: event.contract.lines[0]?.variantId });
    }
    this.events.set(event.webhookId, { ...this.events.get(event.webhookId), processed: true, processedAt: new Date(), errorMessage: undefined });
  }

  async markEventFailed(eventId: string, errorMessage: string) {
    this.events.set(eventId, { processed: false, errorMessage });
  }
}

function body(topic: string, webhookId: string, payload: ShopifyEventPayload = {}) {
  const id = optionalString(payload, "admin_graphql_api_id") ?? contractId;
  return {
    shop: "known.myshopify.com",
    topic,
    webhookId,
    payload,
    ...(topic.startsWith("subscription_contracts/") ? { contract: {
      id,
      status: optionalString(payload, "status") ?? "ACTIVE",
      currencyCode: optionalString(payload, "currency_code") ?? "BRL",
      billingPolicy: {
        interval: optionalString((payload.billing_policy as ShopifyEventPayload | undefined) ?? {}, "interval") ?? "MONTH",
        intervalCount: Number((payload.billing_policy as ShopifyEventPayload | undefined)?.interval_count ?? 1),
      },
      deliveryPolicy: { interval: "MONTH", intervalCount: 1 },
      lines: [],
    } } : {}),
    receivedAt: "2026-08-14T12:00:00.000Z",
  };
}

const contractId = "gid://shopify/SubscriptionContract/1";

test("returns success without processing a duplicate event twice", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  const event = body("subscription_contracts/create", "webhook-1", {
    admin_graphql_api_id: contractId,
    status: "active",
  });

  await service.ingest(event);
  const duplicate = await service.ingest(event);

  assert.deepEqual(duplicate, { duplicate: true, processed: true });
  assert.equal(repository.processCount, 1);
});

test("reprocesses one existing failed event without creating a second row", async () => {
  const repository = new MemoryRepository();
  repository.failNextProcessing = true;
  const service = new ShopifyEventIngestionService(repository);
  const event = body("subscription_contracts/create", "webhook-retry", {
    admin_graphql_api_id: contractId,
  });

  await assert.rejects(service.ingest(event), /transient failure/);
  assert.equal(repository.events.get("webhook-retry")?.processed, false);
  assert.equal(repository.events.size, 1);

  const retried = await service.ingest(event);

  assert.deepEqual(retried, { duplicate: true, processed: true });
  assert.equal(repository.processCount, 2);
  assert.equal(repository.events.size, 1);
  assert.equal(repository.events.get("webhook-retry")?.errorMessage, undefined);
  assert.ok(repository.events.get("webhook-retry")?.processedAt);
});

test("creates a contract mirror from available webhook fields", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(body("subscription_contracts/create", "webhook-2", {
    admin_graphql_api_id: contractId,
    status: "active",
    currency_code: "BRL",
    billing_policy: { interval: "month", interval_count: 1 },
  }));

  assert.equal(repository.contracts.get(contractId)?.status, "active");
  assert.equal(repository.contracts.get(contractId)?.currencyCode, "BRL");
  assert.equal(repository.contracts.get(contractId)?.billingIntervalCount, 1);
});

test("updates a contract without replacing omitted fields", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(body("subscription_contracts/create", "webhook-3", {
    admin_graphql_api_id: contractId,
    status: "active",
    currency_code: "BRL",
    billing_policy: { interval: "month", interval_count: 1 },
  }));
  await service.ingest(body("subscription_contracts/update", "webhook-4", {
    admin_graphql_api_id: contractId,
    status: "paused",
  }));

  assert.equal(repository.contracts.get(contractId)?.status, "paused");
  assert.equal(repository.contracts.get(contractId)?.currencyCode, "BRL");
});

test("creates a minimal contract mirror when update arrives before create", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);

  await service.ingest(body("subscription_contracts/update", "webhook-update-first", {
    admin_graphql_api_id: contractId,
  }));

  assert.equal(repository.contracts.has(contractId), true);
  assert.equal(repository.contracts.get(contractId)?.status, undefined);
  assert.equal(repository.contracts.get(contractId)?.interval, undefined);
});

test("keeps a billing attempt that arrives before contract creation", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);

  await service.ingest(body("subscription_billing_attempts/success", "webhook-attempt-first", {
    admin_graphql_api_subscription_contract_id: contractId,
    admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/early",
  }));

  assert.equal(repository.contracts.has(contractId), true);
  assert.equal(repository.contracts.get(contractId)?.status, undefined);
  assert.equal(repository.attempts.length, 1);
  assert.equal(repository.attempts[0]?.status, "succeeded");
});

test("does not duplicate a billing attempt when a failed webhook is retried", async () => {
  const repository = new MemoryRepository();
  repository.failNextProcessing = true;
  const service = new ShopifyEventIngestionService(repository);
  const event = body("subscription_billing_attempts/success", "webhook-attempt-retry", {
    admin_graphql_api_subscription_contract_id: contractId,
    admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/retry",
  });

  await assert.rejects(service.ingest(event), /transient failure/);
  await service.ingest(event);
  await service.ingest(event);

  assert.equal(repository.attempts.length, 1);
  assert.equal(repository.attempts[0]?.webhookEventId, "webhook-attempt-retry");
  assert.equal(repository.processCount, 2);
});

test("records a successful billing attempt and its Shopify order", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(body("subscription_contracts/create", "webhook-5", {
    admin_graphql_api_id: contractId,
    billing_policy: { interval: "month", interval_count: 1 },
  }));
  await service.ingest(body("subscription_billing_attempts/success", "webhook-6", {
    admin_graphql_api_subscription_contract_id: contractId,
    admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/1",
    admin_graphql_api_order_id: "gid://shopify/Order/1",
  }));

  assert.equal(repository.attempts[0]?.status, "succeeded");
  assert.equal(repository.attempts[0]?.shopifyOrderId, "gid://shopify/Order/1");
});

test("records billing failure details without scheduling a retry", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(body("subscription_contracts/create", "webhook-7", {
    admin_graphql_api_id: contractId,
    billing_policy: { interval: "month", interval_count: 1 },
  }));
  await service.ingest(body("subscription_billing_attempts/failure", "webhook-8", {
    admin_graphql_api_subscription_contract_id: contractId,
    error_code: "CARD_DECLINED",
    error_message: "Payment failed",
  }));

  assert.equal(repository.attempts[0]?.status, "failed");
  assert.equal(repository.attempts[0]?.errorCode, "CARD_DECLINED");
});

test("rejects an event for an unknown shop", async () => {
  const service = new ShopifyEventIngestionService(new MemoryRepository());
  await assert.rejects(
    service.ingest({ ...body("app/uninstalled", "webhook-9"), shop: "missing.myshopify.com" }),
    ShopifyShopNotFoundError,
  );
});

test("rejects an invalid API key using constant-time digests", () => {
  assert.equal(secureApiKeyMatches("wrong", "expected"), false);
  assert.equal(secureApiKeyMatches("expected", "expected"), true);
});

test("returns forbidden from the middleware for an invalid API key", () => {
  const previousApiKey = process.env.API_KEY;
  process.env.API_KEY = "expected";
  let statusCode = 0;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  };

  apiAuth(
    { headers: { "x-api-key": "wrong" } } as never,
    response as never,
    (() => assert.fail("next must not be called")) as never,
  );
  if (previousApiKey === undefined) {
    delete process.env.API_KEY;
  } else {
    process.env.API_KEY = previousApiKey;
  }
  assert.equal(statusCode, 403);
});

test("records a challenged billing attempt without cancelling the contract", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(body("subscription_contracts/create", "webhook-11", {
    admin_graphql_api_id: contractId,
    status: "active",
    billing_policy: { interval: "month", interval_count: 1 },
  }));
  await service.ingest(body("subscription_billing_attempts/challenged", "webhook-12", {
    admin_graphql_api_subscription_contract_id: contractId,
    next_action_url: "https://example.test/authenticate",
  }));

  assert.equal(repository.attempts[0]?.status, "challenged");
  assert.equal(repository.attempts[0]?.nextActionUrl, "https://example.test/authenticate");
  assert.equal(repository.contracts.get(contractId)?.status, "active");
});

test("marks a shop inactive without deleting its mirrored data", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(body("subscription_contracts/create", "webhook-before-uninstall", {
    admin_graphql_api_id: contractId,
    status: "active",
  }));
  await service.ingest(body("app/uninstalled", "webhook-10"));

  assert.equal(repository.shops.get("known.myshopify.com")?.isActive, false);
  assert.equal(repository.events.get("webhook-10")?.processed, true);
  assert.equal(repository.contracts.get(contractId)?.status, "active");
});

const enrichedContract: NormalizedShopifyContract = {
    id: contractId, status: "ACTIVE", nextBillingAt: "2026-09-14T12:00:00.000Z", currencyCode: "BRL",
    originOrder: { id: "gid://shopify/Order/1", financialStatus: "PAID", amount: "99.90", processedAt: "2026-08-14T12:00:00.000Z" },
    customer: { id: "gid://shopify/Customer/1" }, billingPolicy: { interval: "MONTH", intervalCount: 1 },
    deliveryPolicy: { interval: "WEEK", intervalCount: 2 },
    lines: [{ id: "gid://shopify/SubscriptionLine/1", productId: "gid://shopify/Product/1", variantId: "gid://shopify/ProductVariant/1", quantity: 1, currentPrice: { amount: "99.90", currencyCode: "BRL" } }],
  };

test("creates a new Shopify subscription with null Stripe identifiers", () => {
  const data = newShopifySubscriptionData(enrichedContract);
  assert.equal(data.gateway, "shopify");
  assert.equal(data.externalId, null);
  assert.equal(data.stripeCustomerId, null);
  assert.equal(data.stripePaymentMethodId, null);
});

test("contract updates never contain Stripe identifiers or gateway", () => {
  const patch = contractUpdatePatch(enrichedContract);
  assert.equal("externalId" in patch, false);
  assert.equal("stripeCustomerId" in patch, false);
  assert.equal("stripePaymentMethodId" in patch, false);
  assert.equal("gateway" in patch, false);
  assert.equal(patch.shopifyOriginOrderId, "gid://shopify/Order/1");
});

test("redelivered create preserves historical Stripe fields and gateway", () => {
  const historical = { gateway: "stripe", externalId: "sub_old", stripeCustomerId: "cus_old", stripePaymentMethodId: "pm_old" };
  const result = { ...historical, ...contractUpdatePatch(enrichedContract) };
  assert.deepEqual({ gateway: result.gateway, externalId: result.externalId, stripeCustomerId: result.stripeCustomerId, stripePaymentMethodId: result.stripePaymentMethodId }, historical);
});

test("partial updates preserve existing data and a null gateway can become Shopify", () => {
  const existing = { gateway: null as string | null, externalId: "legacy", currencyCode: "BRL" };
  const partial = Object.fromEntries(Object.entries(contractUpdatePatch({ ...enrichedContract, customer: undefined, lines: [] })).filter(([, value]) => value !== undefined));
  const result = { ...existing, ...partial, gateway: existing.gateway ?? "shopify" };
  assert.equal(result.gateway, "shopify");
  assert.equal(result.externalId, "legacy");
  assert.equal(result.currencyCode, "BRL");
});

test("accepts optional enriched contract fields being absent", async () => {
  const event = body("subscription_contracts/create", "minimal-enriched", { admin_graphql_api_id: contractId });
  const repository = new MemoryRepository();
  await new ShopifyEventIngestionService(repository).ingest(event);
  assert.equal(repository.events.get("minimal-enriched")?.processed, true);
});

function linkedContractEvent(webhookId: string, lineNumbers: number[], topic = "subscription_contracts/create") {
  const event = body(topic, webhookId, { admin_graphql_api_id: contractId, status: "active" });
  return {
    ...event,
    shopifyShopId: "gid://shopify/Shop/123",
    shopifyEventId: "shopify-event-shared",
    contract: {
      ...event.contract!,
      revisionId: "revision-9",
      lines: lineNumbers.map((number) => ({
        id: `gid://shopify/SubscriptionLine/${number}`,
        productId: `gid://shopify/Product/${number}`,
        variantId: `gid://shopify/ProductVariant/${number}`,
        sellingPlanId: `gid://shopify/SellingPlan/${number}`,
        quantity: number,
        currentPrice: { amount: `${number * 10}.00`, currencyCode: "BRL" },
      })),
    },
  };
}

test("stores the Shopify shop, event and revision identifiers", async () => {
  const repository = new MemoryRepository();
  await new ShopifyEventIngestionService(repository).ingest(linkedContractEvent("delivery-link-1", [1]));
  assert.equal(repository.shops.get("known.myshopify.com")?.shopifyShopId, "gid://shopify/Shop/123");
  assert.equal(repository.events.get("delivery-link-1")?.shopifyEventId, "shopify-event-shared");
  assert.equal(repository.contracts.get(contractId)?.shopifyRevisionId, "revision-9");
});

test("allows multiple deliveries to share one Shopify event identifier", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(linkedContractEvent("delivery-a", [1]));
  await service.ingest(linkedContractEvent("delivery-b", [1], "subscription_contracts/update"));
  assert.equal([...repository.events.values()].filter((event) => event.shopifyEventId === "shopify-event-shared").length, 2);
});

test("stores multiple lines without duplicating them on upsert", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(linkedContractEvent("lines-1", [1, 2]));
  await service.ingest(linkedContractEvent("lines-2", [1, 2], "subscription_contracts/update"));
  assert.equal(repository.lines.get(contractId)?.size, 2);
  assert.equal(repository.lines.get(contractId)?.get("gid://shopify/SubscriptionLine/2")?.sellingPlanId, "gid://shopify/SellingPlan/2");
});

test("updates line quantity and price", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(linkedContractEvent("line-update-1", [1]));
  const changed = linkedContractEvent("line-update-2", [1], "subscription_contracts/update");
  changed.contract.lines[0]!.quantity = 5;
  changed.contract.lines[0]!.currentPrice.amount = "55.00";
  await service.ingest(changed);
  assert.deepEqual(repository.lines.get(contractId)?.get("gid://shopify/SubscriptionLine/1"), { quantity: 5, currentPrice: "55.00", isActive: true, sellingPlanId: "gid://shopify/SellingPlan/1" });
});

test("deactivates removed lines and reactivates a readded line", async () => {
  const repository = new MemoryRepository();
  const service = new ShopifyEventIngestionService(repository);
  await service.ingest(linkedContractEvent("line-life-1", [1, 2]));
  await service.ingest(linkedContractEvent("line-life-2", [], "subscription_contracts/update"));
  assert.equal(repository.lines.get(contractId)?.get("gid://shopify/SubscriptionLine/1")?.isActive, false);
  await service.ingest(linkedContractEvent("line-life-3", [1], "subscription_contracts/update"));
  assert.equal(repository.lines.get(contractId)?.get("gid://shopify/SubscriptionLine/1")?.isActive, true);
  assert.equal(repository.lines.get(contractId)?.get("gid://shopify/SubscriptionLine/2")?.isActive, false);
});

test("keeps singular product and variant compatibility fields from the first line", async () => {
  const repository = new MemoryRepository();
  await new ShopifyEventIngestionService(repository).ingest(linkedContractEvent("singular-ids", [7, 8]));
  assert.equal(repository.contracts.get(contractId)?.shopifyProductId, "gid://shopify/Product/7");
  assert.equal(repository.contracts.get(contractId)?.shopifyVariantId, "gid://shopify/ProductVariant/7");
});
