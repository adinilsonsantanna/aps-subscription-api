import test from "node:test";
import assert from "node:assert/strict";
import { apiAuth, secureApiKeyMatches } from "../../../middlewares/apiAuth";
import {
  ShopifyEventRepository,
  billingAttemptDataFromPayload,
  contractPatchFromPayload,
} from "../shopify-event.repository";
import { ShopifyEventIngestionService } from "../shopify-event.service";
import {
  IncomingShopifyEvent,
  ShopifyEventPayload,
  ShopifyShopNotFoundError,
  contractIdFromPayload,
  optionalString,
} from "../shopify-event.types";

class MemoryRepository implements ShopifyEventRepository {
  shops = new Map([["known.myshopify.com", { id: "shop-1", isActive: true }]]);
  events = new Map<string, { processed: boolean; processedAt?: Date; errorMessage?: string }>();
  contracts = new Map<string, Partial<ReturnType<typeof contractPatchFromPayload>>>();
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
    this.events.set(event.webhookId, { processed: false });
  }

  async processEvent(event: IncomingShopifyEvent) {
    this.processCount += 1;
    if (this.failNextProcessing) {
      this.failNextProcessing = false;
      throw new Error("transient failure");
    }

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
    this.events.set(event.webhookId, { processed: true, processedAt: new Date() });
  }

  async markEventFailed(eventId: string, errorMessage: string) {
    this.events.set(eventId, { processed: false, errorMessage });
  }
}

function body(topic: string, webhookId: string, payload: ShopifyEventPayload = {}) {
  return {
    shop: "known.myshopify.com",
    topic,
    webhookId,
    payload,
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
  assert.equal(repository.attempts[0]?.status, "SUCCEEDED");
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

  assert.equal(repository.attempts[0]?.status, "SUCCEEDED");
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

  assert.equal(repository.attempts[0]?.status, "FAILED");
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

  assert.equal(repository.attempts[0]?.status, "CHALLENGED");
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
