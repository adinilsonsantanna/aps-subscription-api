import { Prisma, PrismaClient } from "@prisma/client";
import {
  IncomingShopifyEvent,
  ShopifyEventPayload,
  ShopifyEventTopic,
  contractIdFromPayload,
  optionalDate,
  optionalInteger,
  optionalObject,
  optionalString,
} from "./shopify-event.types";

export interface ShopifyEventShop {
  id: string;
  isActive: boolean;
}

export interface ShopifyEventRepository {
  findShopByDomain(domain: string): Promise<ShopifyEventShop | null>;
  findEventById(eventId: string): Promise<{ processed: boolean } | null>;
  createEvent(event: IncomingShopifyEvent, shopId: string): Promise<void>;
  processEvent(event: IncomingShopifyEvent, shopId: string): Promise<void>;
  markEventFailed(eventId: string, errorMessage: string): Promise<void>;
}

function contractIdForContractWebhook(payload: ShopifyEventPayload) {
  return optionalString(payload, "admin_graphql_api_id");
}

export function contractPatchFromPayload(payload: ShopifyEventPayload) {
  const billingPolicy = optionalObject(payload, "billing_policy");
  const deliveryPolicy = optionalObject(payload, "delivery_policy");

  return {
    shopifyOriginOrderId: optionalString(
      payload,
      "admin_graphql_api_origin_order_id",
      "origin_order_id",
    ),
    shopifyCustomerId: optionalString(
      payload,
      "admin_graphql_api_customer_id",
      "customer_id",
    ),
    status: optionalString(payload, "status"),
    currencyCode: optionalString(payload, "currency_code"),
    billingInterval: optionalString(billingPolicy, "interval"),
    billingIntervalCount: optionalInteger(billingPolicy, "interval_count"),
    deliveryInterval: optionalString(deliveryPolicy, "interval"),
    deliveryIntervalCount: optionalInteger(deliveryPolicy, "interval_count"),
    interval: optionalInteger(billingPolicy, "interval_count"),
    intervalType: optionalString(billingPolicy, "interval"),
    nextBillingAt: optionalDate(payload, "next_billing_at", "next_billing_date"),
  } satisfies Prisma.SubscriptionUncheckedUpdateInput;
}

export function billingAttemptDataFromPayload(
  topic: Extract<ShopifyEventTopic, `subscription_billing_attempts/${string}`>,
  payload: ShopifyEventPayload,
) {
  const status = topic.endsWith("/success")
    ? "SUCCEEDED"
    : topic.endsWith("/failure")
      ? "FAILED"
      : "CHALLENGED";
  const nestedOrder = optionalObject(payload, "order");

  return {
    status,
    shopifyBillingAttemptId: optionalString(payload, "admin_graphql_api_id", "id"),
    idempotencyKey: optionalString(payload, "idempotency_key"),
    errorCode: optionalString(payload, "error_code"),
    errorMessage: optionalString(payload, "error_message"),
    shopifyOrderId: optionalString(
      payload,
      "admin_graphql_api_order_id",
      "order_id",
    ) ?? optionalString(nestedOrder, "admin_graphql_api_id", "id"),
    nextActionUrl: optionalString(payload, "next_action_url"),
    attemptedAt: optionalDate(payload, "attempted_at", "created_at", "completed_at"),
  };
}

export class PrismaShopifyEventRepository implements ShopifyEventRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  findShopByDomain(domain: string) {
    return this.prisma.shop.findUnique({
      where: { domain },
      select: { id: true, isActive: true },
    });
  }

  findEventById(eventId: string) {
    return this.prisma.webhookEvent.findUnique({
      where: { eventId },
      select: { processed: true },
    });
  }

  async createEvent(event: IncomingShopifyEvent, shopId: string) {
    await this.prisma.webhookEvent.create({
      data: {
        shopId,
        source: "shopify",
        topic: event.topic,
        eventId: event.webhookId,
        payload: event.payload as Prisma.InputJsonObject,
        receivedAt: event.receivedAt,
      },
    });
  }

  async processEvent(event: IncomingShopifyEvent, shopId: string) {
    await this.prisma.$transaction(async (transaction) => {
      switch (event.topic) {
        case "subscription_contracts/create":
          await this.upsertContract(transaction, event.payload, shopId);
          break;
        case "subscription_contracts/update":
          await this.updateContract(transaction, event.payload, shopId);
          break;
        case "subscription_billing_attempts/success":
        case "subscription_billing_attempts/failure":
        case "subscription_billing_attempts/challenged":
          await this.recordBillingAttempt(transaction, event.topic, event.payload, shopId);
          break;
        case "app/uninstalled":
          await transaction.shop.update({
            where: { id: shopId },
            data: { isActive: false },
          });
          break;
      }

      await transaction.webhookEvent.update({
        where: { eventId: event.webhookId },
        data: { processed: true, processedAt: new Date(), errorMessage: null },
      });
    });
  }

  async markEventFailed(eventId: string, errorMessage: string) {
    await this.prisma.webhookEvent.update({
      where: { eventId },
      data: { errorMessage },
    });
  }

  private async upsertContract(
    transaction: Prisma.TransactionClient,
    payload: ShopifyEventPayload,
    shopId: string,
  ) {
    const shopifyContractId = contractIdForContractWebhook(payload);
    if (!shopifyContractId) throw new Error("Contract identifier is unavailable");
    const patch = contractPatchFromPayload(payload);
    const interval = optionalInteger(optionalObject(payload, "billing_policy"), "interval_count");
    const intervalType = optionalString(optionalObject(payload, "billing_policy"), "interval");
    if (interval === undefined || !intervalType) {
      throw new Error("Billing policy is unavailable; GraphQL synchronization is required");
    }

    await transaction.subscription.upsert({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      create: { shopId, shopifyContractId, ...patch, interval, intervalType },
      update: patch,
    });
  }

  private async updateContract(
    transaction: Prisma.TransactionClient,
    payload: ShopifyEventPayload,
    shopId: string,
  ) {
    const shopifyContractId = contractIdForContractWebhook(payload);
    if (!shopifyContractId) throw new Error("Contract identifier is unavailable");

    await transaction.subscription.update({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      data: contractPatchFromPayload(payload),
    });
  }

  private async recordBillingAttempt(
    transaction: Prisma.TransactionClient,
    topic: Extract<ShopifyEventTopic, `subscription_billing_attempts/${string}`>,
    payload: ShopifyEventPayload,
    shopId: string,
  ) {
    const shopifyContractId = contractIdFromPayload(payload);
    if (!shopifyContractId) throw new Error("Contract identifier is unavailable");

    const subscription = await transaction.subscription.findUnique({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      select: { id: true },
    });
    if (!subscription) throw new Error("Subscription is unavailable");

    const attempt = billingAttemptDataFromPayload(topic, payload);
    const data = {
      shopId,
      subscriptionId: subscription.id,
      shopifyContractId,
      ...attempt,
    };

    if (attempt.shopifyBillingAttemptId) {
      await transaction.subscriptionBillingAttempt.upsert({
        where: {
          shopId_shopifyBillingAttemptId: {
            shopId,
            shopifyBillingAttemptId: attempt.shopifyBillingAttemptId,
          },
        },
        create: data,
        update: attempt,
      });
    } else if (attempt.idempotencyKey) {
      await transaction.subscriptionBillingAttempt.upsert({
        where: { shopId_idempotencyKey: { shopId, idempotencyKey: attempt.idempotencyKey } },
        create: data,
        update: attempt,
      });
    } else {
      await transaction.subscriptionBillingAttempt.create({ data });
    }

    await transaction.subscription.update({
      where: { id: subscription.id },
      data: { lastPaymentStatus: attempt.status },
    });
  }
}
