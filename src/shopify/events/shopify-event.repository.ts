import { Prisma, PrismaClient } from "@prisma/client";
import {
  IncomingShopifyEvent,
  NormalizedShopifyContract,
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

export function contractUpdatePatch(contract: NormalizedShopifyContract) {
  const firstLine = contract.lines[0];
  return {
    shopifyOriginOrderId: contract.originOrder?.id,
    shopifyRevisionId: contract.revisionId,
    shopifyCustomerId: contract.customer?.id,
    shopifyProductId: firstLine?.productId,
    shopifyVariantId: firstLine?.variantId,
    status: contract.status.toLowerCase(),
    currencyCode: contract.currencyCode,
    billingInterval: contract.billingPolicy.interval.toLowerCase(),
    billingIntervalCount: contract.billingPolicy.intervalCount,
    deliveryInterval: contract.deliveryPolicy.interval.toLowerCase(),
    deliveryIntervalCount: contract.deliveryPolicy.intervalCount,
    interval: contract.billingPolicy.intervalCount,
    intervalType: contract.billingPolicy.interval.toLowerCase(),
    nextBillingAt: contract.nextBillingAt ? new Date(contract.nextBillingAt) : undefined,
  } satisfies Prisma.SubscriptionUncheckedUpdateInput;
}

export function newShopifySubscriptionData(contract: NormalizedShopifyContract) {
  return {
    ...contractUpdatePatch(contract),
    gateway: "shopify",
    externalId: null,
    stripeCustomerId: null,
    stripePaymentMethodId: null,
  } satisfies Omit<Prisma.SubscriptionUncheckedCreateInput, "shopId">;
}

function revisionNumber(value?: string | null) {
  const match = value?.match(/(\d+)(?:\D*)$/);
  return match ? BigInt(match[1]) : undefined;
}

export function shouldApplyShopifyContractEvent(currentStatus: string | null | undefined, currentRevision: string | null | undefined, incomingStatus: string, incomingRevision?: string) {
  const current = String(currentStatus || "").toLowerCase();
  const next = incomingStatus.toLowerCase();
  if (["cancelled", "expired", "failed"].includes(current) && ["active", "paused"].includes(next)) return false;
  const previousNumber = revisionNumber(currentRevision);
  const incomingNumber = revisionNumber(incomingRevision);
  if (previousNumber !== undefined && incomingNumber !== undefined && incomingNumber <= previousNumber) return false;
  if (!incomingRevision && current && current !== next && !["cancelled", "expired", "failed"].includes(next)) return false;
  return true;
}

export function billingAttemptDataFromPayload(
  topic: Extract<ShopifyEventTopic, `subscription_billing_attempts/${string}`>,
  payload: ShopifyEventPayload,
) {
  const status = topic.endsWith("/success")
    ? "succeeded"
    : topic.endsWith("/failure")
      ? "failed"
      : "challenged";
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
        shopifyEventId: event.shopifyEventId,
        payload: event.payload as Prisma.InputJsonObject,
        receivedAt: event.receivedAt,
      },
    });
  }

  async processEvent(event: IncomingShopifyEvent, shopId: string) {
    await this.prisma.$transaction(async (transaction) => {
      if (event.shopifyShopId) {
        await transaction.shop.update({ where: { id: shopId }, data: { shopifyShopId: event.shopifyShopId } });
      }
      switch (event.topic) {
        case "subscription_contracts/create":
          await this.upsertContract(transaction, event.contract!, shopId);
          break;
        case "subscription_contracts/update":
          await this.updateContract(transaction, event.contract!, shopId);
          break;
        case "subscription_billing_attempts/success":
        case "subscription_billing_attempts/failure":
        case "subscription_billing_attempts/challenged":
          await this.recordBillingAttempt(
            transaction,
            event.topic,
            event.payload,
            shopId,
            event.webhookId,
          );
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
        data: { processed: true, processedAt: new Date(), errorMessage: null, ...(event.shopifyEventId && { shopifyEventId: event.shopifyEventId }) },
      });
    });
  }

  async markEventFailed(eventId: string, errorMessage: string) {
    await this.prisma.webhookEvent.update({
      where: { eventId },
      data: { processed: false, processedAt: null, errorMessage },
    });
  }

  private async upsertContract(
    transaction: Prisma.TransactionClient,
    contract: NormalizedShopifyContract,
    shopId: string,
  ) {
    const shopifyContractId = contract.id;
    const createData = newShopifySubscriptionData(contract);
    const patch = contractUpdatePatch(contract);
    const existing = await transaction.subscription.findUnique({ where: { shopId_shopifyContractId: { shopId, shopifyContractId } }, select: { status: true, shopifyRevisionId: true } });
    if (existing && !shouldApplyShopifyContractEvent(existing.status, existing.shopifyRevisionId, contract.status, contract.revisionId)) return;

    const subscription = await transaction.subscription.upsert({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      create: { shopId, shopifyContractId, ...createData },
      update: patch,
      select: { id: true, gateway: true },
    });
    if (subscription.gateway === null) {
      await transaction.subscription.update({ where: { id: subscription.id }, data: { gateway: "shopify" } });
    }
    await this.syncContractLines(transaction, subscription.id, contract);
    if (contract.originOrder?.amount && contract.originOrder.financialStatus) {
      const paid = contract.originOrder.financialStatus.toUpperCase() === "PAID";
      await transaction.subscriptionOrder.upsert({
        where: { shopifyOrderKey: `${shopId}:${contract.originOrder.id}` },
        create: {
          subscriptionId: subscription.id,
          shopifyOrderId: contract.originOrder.id,
          shopifyOrderKey: `${shopId}:${contract.originOrder.id}`,
          amount: contract.originOrder.amount,
          status: contract.originOrder.financialStatus.toUpperCase(),
          processedAt: paid ? new Date(contract.originOrder.processedAt ?? new Date()) : null,
        },
        update: {},
      });
    }
  }

  private async updateContract(
    transaction: Prisma.TransactionClient,
    contract: NormalizedShopifyContract,
    shopId: string,
  ) {
    const shopifyContractId = contract.id;
    const requestedPatch = Object.fromEntries(Object.entries(contractUpdatePatch(contract)).filter(([, value]) => value !== undefined));
    const existing = await transaction.subscription.findUnique({ where: { shopId_shopifyContractId: { shopId, shopifyContractId } }, select: { status: true, lastPaymentStatus: true, shopifyRevisionId: true } });
    if (existing && !shouldApplyShopifyContractEvent(existing.status, existing.shopifyRevisionId, contract.status, contract.revisionId)) return;
    const terminal = ["cancelled", "expired", "failed"].includes(String(existing?.status).toLowerCase());
    const patch = terminal && contract.status.toLowerCase() === "active"
      ? Object.fromEntries(Object.entries(requestedPatch).filter(([key]) => key !== "status"))
      : requestedPatch;
    const subscription = await transaction.subscription.upsert({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      create: { shopId, shopifyContractId, ...newShopifySubscriptionData(contract) },
      update: patch,
      select: { id: true, gateway: true },
    });
    if (subscription.gateway === null) {
      await transaction.subscription.update({ where: { id: subscription.id }, data: { gateway: "shopify" } });
    }
    const newStatus = terminal && contract.status.toLowerCase() === "active" ? existing?.status : contract.status.toLowerCase();
    if (newStatus) await transaction.subscriptionStatusHistory.upsert({
      where: { source_sourceEventId: { source: "shopify_webhook", sourceEventId: contract.revisionId || `contract:${shopId}:${shopifyContractId}:${newStatus}` } },
      create: { subscriptionId: subscription.id, previousStatus: existing?.status, newStatus, previousPaymentStatus: existing?.lastPaymentStatus, newPaymentStatus: existing?.lastPaymentStatus, source: "shopify_webhook", sourceEventId: contract.revisionId || `contract:${shopId}:${shopifyContractId}:${newStatus}` },
      update: {},
    });
    await this.syncContractLines(transaction, subscription.id, contract);
  }

  private async syncContractLines(
    transaction: Prisma.TransactionClient,
    subscriptionId: string,
    contract: NormalizedShopifyContract,
  ) {
    const activeIds = contract.lines.map((line) => line.id);
    await transaction.subscriptionLine.updateMany({
      where: {
        subscriptionId,
        isActive: true,
        ...(activeIds.length ? { shopifySubscriptionLineId: { notIn: activeIds } } : {}),
      },
      data: { isActive: false },
    });
    for (const line of contract.lines) {
      const data = {
        shopifyProductId: line.productId,
        shopifyVariantId: line.variantId,
        shopifySellingPlanId: line.sellingPlanId,
        quantity: line.quantity,
        currentPrice: line.currentPrice.amount,
        currencyCode: line.currentPrice.currencyCode,
        isActive: true,
      };
      await transaction.subscriptionLine.upsert({
        where: { subscriptionId_shopifySubscriptionLineId: { subscriptionId, shopifySubscriptionLineId: line.id } },
        create: { subscriptionId, shopifySubscriptionLineId: line.id, ...data },
        update: data,
      });
    }
  }

  private async recordBillingAttempt(
    transaction: Prisma.TransactionClient,
    topic: Extract<ShopifyEventTopic, `subscription_billing_attempts/${string}`>,
    payload: ShopifyEventPayload,
    shopId: string,
    webhookEventId: string,
  ) {
    const shopifyContractId = contractIdFromPayload(payload);
    if (!shopifyContractId) throw new Error("Contract identifier is unavailable");

    const subscription = await transaction.subscription.upsert({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      create: { shopId, shopifyContractId },
      update: {},
      select: { id: true, status: true },
    });

    const attempt = billingAttemptDataFromPayload(topic, payload);
    const data = {
      shopId,
      subscriptionId: subscription.id,
      shopifyContractId,
      webhookEventId,
      ...attempt,
    };

    await transaction.subscriptionBillingAttempt.upsert({
      where: { webhookEventId },
      create: data,
      update: attempt,
    });

    await transaction.subscription.update({
      where: { id: subscription.id },
      data: { lastPaymentStatus: attempt.status },
    });
    await transaction.subscriptionStatusHistory.upsert({
      where: { source_sourceEventId: { source: "shopify_webhook", sourceEventId: webhookEventId } },
      create: { subscriptionId: subscription.id, newStatus: subscription.status || "active", newPaymentStatus: attempt.status, source: "shopify_webhook", sourceEventId: webhookEventId },
      update: {},
    });
  }
}
