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
import { NotificationEventService } from "../../notifications/NotificationEventService";
import { canonicalBillingSourceKey } from "../../notifications/billing-notification-identity";
import { canonicalizeShopId } from "../../utils/shopId";
import { ShopifyShopIdentityMismatchError } from "./shopify-event.types";

export interface ShopifyEventShop {
  id: string;
  isActive: boolean;
  shopifyShopId: string | null;
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
    shopifyCustomerEmail: contract.customer?.email,
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
    billingCycleAt: optionalDate(payload, "billing_cycle_at", "billing_cycle_date"),
  };
}

export function reconciledBillingAttemptData(event: IncomingShopifyEvent) {
  const raw = billingAttemptDataFromPayload(event.topic as Extract<ShopifyEventTopic, `subscription_billing_attempts/${string}`>, event.payload);
  const enriched = event.billingAttempt;
  return {
    ...raw,
    shopifyBillingAttemptId: enriched?.id ?? raw.shopifyBillingAttemptId,
    idempotencyKey: enriched?.idempotencyKey ?? raw.idempotencyKey,
    shopifyOrderId: enriched?.order?.id ?? raw.shopifyOrderId,
    attemptedAt: enriched?.completedAt ? new Date(enriched.completedAt) : event.triggeredAt,
    cycleOriginTime: enriched?.cycleOriginTime ? new Date(enriched.cycleOriginTime) : raw.billingCycleAt,
    completedAt: enriched?.completedAt ? new Date(enriched.completedAt) : undefined,
    orderAmount: enriched?.order?.amount,
    orderCurrencyCode: enriched?.order?.currencyCode,
    reconciliationStatus: enriched?.reconciliationStatus === "complete" ? "complete" : "pending",
  };
}

export class PrismaShopifyEventRepository implements ShopifyEventRepository {
  constructor(private readonly prisma = new PrismaClient(), private readonly notifications = new NotificationEventService(prisma)) {}

  findShopByDomain(domain: string) {
    return this.prisma.shop.findUnique({
      where: { domain },
      select: { id: true, isActive: true, shopifyShopId: true },
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
    let contractTransition: { eventType: string; sourceKey: string; subscriptionId: string; customerEmail: string | null } | null = null;
    let reconciliationPending = false;
    await this.prisma.$transaction(async (transaction) => {
      const canonicalEventShopId = event.shopifyShopId ? canonicalizeShopId(event.shopifyShopId) : undefined;
      if (event.shopifyShopId) {
        const storedIdentity = await transaction.shop.findUnique({ where: { id: shopId }, select: { shopifyShopId: true } });
        if (!storedIdentity?.shopifyShopId || canonicalizeShopId(storedIdentity.shopifyShopId) !== canonicalEventShopId) {
          throw new ShopifyShopIdentityMismatchError("Shop event identity does not match the registered shop");
        }
      }
      switch (event.topic) {
        case "subscription_contracts/create":
          await this.upsertContract(transaction, event.contract!, shopId);
          break;
        case "subscription_contracts/update":
          contractTransition = await this.updateContract(transaction, event.contract!, shopId);
          break;
        case "subscription_billing_attempts/success":
        case "subscription_billing_attempts/failure":
        case "subscription_billing_attempts/challenged":
          reconciliationPending = await this.recordBillingAttempt(
            transaction,
            event,
            shopId,
            event.webhookId,
          );
          break;
        case "app/uninstalled":
          if (!event.triggeredAt) {
            throw new Error(`[app/uninstalled] Evento sem triggeredAt para shop ${shopId}`);
          }
          if (!canonicalEventShopId) {
            throw new Error(`[app/uninstalled] Evento sem shopifyShopId para shop ${shopId}`);
          }

          const captured = await transaction.shop.findUnique({
            where: { id: shopId },
            select: { installationGeneration: true },
          });
          if (!captured) throw new Error(`[app/uninstalled] Loja nao encontrada: ${shopId}`);

          const result = await transaction.shop.updateMany({
            where: {
              id: shopId,
              domain: event.shop,
              shopifyShopId: canonicalEventShopId,
              installationGeneration: captured.installationGeneration,
              isActive: true,
              AND: [
                {
                  OR: [
                    { lastInstalledAt: null },
                    { lastInstalledAt: { lte: event.triggeredAt } },
                  ],
                },
                {
                  OR: [
                    { lastUninstalledAt: null },
                    { lastUninstalledAt: { lt: event.triggeredAt } },
                  ],
                },
              ],
            },
            data: {
              isActive: false,
              lastUninstalledAt: event.triggeredAt,
            },
          });

          if (result.count > 0) {
            const domains = await transaction.sendingDomain.findMany({ where: { shopId, disabledAt: null }, select: { id: true, apiKeyId: true, pendingApiKeyId: true, previousApiKeyId: true, cleanupJobs: { select: { providerApiKeyId: true } } } });
            for (const domain of domains) { const ids = new Set([domain.apiKeyId, domain.pendingApiKeyId, domain.previousApiKeyId, ...domain.cleanupJobs.map(job => job.providerApiKeyId)].filter((id): id is string => Boolean(id))); for (const providerApiKeyId of ids) await transaction.sendingCredentialCleanupJob.upsert({ where: { sendingDomainId_providerApiKeyId_reason: { sendingDomainId: domain.id, providerApiKeyId, reason: "uninstall" } }, create: { sendingDomainId: domain.id, providerApiKeyId, reason: "uninstall", availableAt: event.triggeredAt }, update: { status: "pending", availableAt: event.triggeredAt, completedAt: null } }); }
            await transaction.sendingDomain.updateMany({
              where: { shopId, disabledAt: null },
              data: { status: "disabled", sendingVerified: false, credentialStatus: "uninstall_pending", disabledAt: event.triggeredAt },
            });
          }
          break;
      }

      await transaction.webhookEvent.update({
        where: { eventId: event.webhookId },
        data: { processed: true, processedAt: new Date(), errorMessage: null, ...(event.shopifyEventId && { shopifyEventId: event.shopifyEventId }) },
      });
    if (reconciliationPending) throw new Error("shopify_billing_attempt_reconciliation_pending");
      });
    if (contractTransition) { const transition = contractTransition as { eventType: string; sourceKey: string; subscriptionId: string; customerEmail: string | null }; await this.notifications.emit({ shopId, eventType: transition.eventType, sourceKey: transition.sourceKey, payload: { subscriptionId: transition.subscriptionId, contractId: event.contract!.id, status: event.contract!.status.toLowerCase() }, customerEmail: transition.customerEmail, occurredAt: event.receivedAt }); }
    if (event.topic === "subscription_billing_attempts/success" || event.topic === "subscription_billing_attempts/failure") {
      const attemptData = billingAttemptDataFromPayload(event.topic, event.payload), contractId = contractIdFromPayload(event.payload);
      if (contractId) { const subscription = await this.prisma.subscription.findUnique({ where: { shopId_shopifyContractId: { shopId, shopifyContractId: contractId } }, select: { id: true, shopifyCustomerEmail: true } }); if (subscription) await this.notifications.emit({ shopId, eventType: event.topic.endsWith("/success") ? "renewal_succeeded" : "payment_failed", sourceKey: canonicalBillingSourceKey({ shopifyBillingAttemptId: attemptData.shopifyBillingAttemptId, idempotencyKey: attemptData.idempotencyKey, shopifyContractId: contractId, billingCycleAt: attemptData.billingCycleAt ?? attemptData.attemptedAt }), payload: { subscriptionId: subscription.id, orderId: attemptData.shopifyOrderId, errorCode: attemptData.errorCode }, customerEmail: subscription.shopifyCustomerEmail, occurredAt: attemptData.attemptedAt ?? event.receivedAt }); }
    }
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
    const existing = await transaction.subscription.findUnique({ where: { shopId_shopifyContractId: { shopId, shopifyContractId } }, select: { status: true, lastPaymentStatus: true, shopifyRevisionId: true, shopifyCustomerEmail: true } });
    if (existing && !shouldApplyShopifyContractEvent(existing.status, existing.shopifyRevisionId, contract.status, contract.revisionId)) return null;
    const terminal = ["cancelled", "expired", "failed"].includes(String(existing?.status).toLowerCase());
    const patch = terminal && contract.status.toLowerCase() === "active"
      ? Object.fromEntries(Object.entries(requestedPatch).filter(([key]) => key !== "status"))
      : requestedPatch;
    const subscription = await transaction.subscription.upsert({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      create: { shopId, shopifyContractId, ...newShopifySubscriptionData(contract) },
      update: patch,
      select: { id: true, gateway: true, shopifyCustomerEmail: true },
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
    const previous = String(existing?.status || "").toLowerCase();
    if (previous !== newStatus && (newStatus === "paused" || newStatus === "cancelled")) return { eventType: newStatus === "paused" ? "subscription_paused" : "subscription_cancelled", sourceKey: `contract:${shopifyContractId}:${newStatus}`, subscriptionId: subscription.id, customerEmail: subscription.shopifyCustomerEmail || existing?.shopifyCustomerEmail || null };
    return null;
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
    event: IncomingShopifyEvent,
    shopId: string,
    webhookEventId: string,
  ) {
    const topic = event.topic as Extract<ShopifyEventTopic, `subscription_billing_attempts/${string}`>;
    const payload = event.payload;
    const shopifyContractId = event.billingAttempt?.contractId ?? contractIdFromPayload(payload);
    if (!shopifyContractId) throw new Error("Contract identifier is unavailable");

    const subscription = await transaction.subscription.upsert({
      where: { shopId_shopifyContractId: { shopId, shopifyContractId } },
      create: { shopId, shopifyContractId },
      update: {},
      select: { id: true, status: true },
    });

    const enriched = event.billingAttempt;
    const attempt = reconciledBillingAttemptData(event);
    const { billingCycleAt: _billingCycleAt, orderAmount, orderCurrencyCode, ...persistedAttempt } = attempt;
    const data = {
      shopId,
      subscriptionId: subscription.id,
      shopifyContractId,
      webhookEventId,
      ...persistedAttempt,
      orderAmount,
      orderCurrencyCode,
      reconciliationAttempts: { increment: 1 },
      reconciliationError: attempt.reconciliationStatus === "complete" ? null : "shopify_order_enrichment_unavailable",
    };

    const existingAttempt = await transaction.subscriptionBillingAttempt.findFirst({
      where: {
        shopId,
        OR: [
          ...(attempt.shopifyBillingAttemptId ? [{ shopifyBillingAttemptId: attempt.shopifyBillingAttemptId }] : []),
          ...(attempt.idempotencyKey ? [{ idempotencyKey: attempt.idempotencyKey }] : []),
          { webhookEventId },
        ],
      },
      select: { id: true },
    });
    if (existingAttempt) {
      await transaction.subscriptionBillingAttempt.update({ where: { id: existingAttempt.id }, data: { ...persistedAttempt, orderAmount, orderCurrencyCode, reconciliationAttempts: { increment: 1 }, reconciliationError: attempt.reconciliationStatus === "complete" ? null : "shopify_order_enrichment_unavailable", webhookEventId } });
    } else {
      await transaction.subscriptionBillingAttempt.create({ data: { ...data, reconciliationAttempts: 1 } });
    }

    const completeSuccess = attempt.status === "succeeded" && attempt.reconciliationStatus === "complete" && attempt.shopifyOrderId && orderAmount && orderCurrencyCode && attempt.attemptedAt && attempt.cycleOriginTime;
    if (completeSuccess) {
      await transaction.subscriptionOrder.upsert({
        where: { shopifyOrderKey: `${shopId}:${attempt.shopifyOrderId}` },
        create: { subscriptionId: subscription.id, shopifyOrderId: attempt.shopifyOrderId!, shopifyOrderKey: `${shopId}:${attempt.shopifyOrderId}`, gatewayOrderId: attempt.shopifyBillingAttemptId, amount: orderAmount!, currencyCode: orderCurrencyCode!, status: enriched?.order?.financialStatus ?? "PAID", processedAt: attempt.attemptedAt! },
        update: { shopifyOrderId: attempt.shopifyOrderId!, gatewayOrderId: attempt.shopifyBillingAttemptId, amount: orderAmount!, currencyCode: orderCurrencyCode!, status: enriched?.order?.financialStatus ?? "PAID", processedAt: attempt.attemptedAt! },
      });
      await transaction.billingRetryCycle.upsert({
        where: { subscriptionId_billingCycleAt: { subscriptionId: subscription.id, billingCycleAt: attempt.cycleOriginTime! } },
        create: { shopId, subscriptionId: subscription.id, billingCycleAt: attempt.cycleOriginTime!, status: "succeeded", nextBillingAdvanced: Boolean(enriched?.nextBillingAt) },
        update: { status: "succeeded", nextBillingAdvanced: Boolean(enriched?.nextBillingAt) },
      });
    }

    await transaction.subscription.update({
      where: { id: subscription.id },
      data: { lastPaymentStatus: attempt.status, ...(completeSuccess && enriched?.nextBillingAt ? { nextBillingAt: new Date(enriched.nextBillingAt) } : {}) },
    });
    await transaction.subscriptionStatusHistory.upsert({
      where: { source_sourceEventId: { source: "shopify_webhook", sourceEventId: webhookEventId } },
      create: { subscriptionId: subscription.id, newStatus: subscription.status || "active", newPaymentStatus: attempt.status, source: "shopify_webhook", sourceEventId: webhookEventId },
      update: {},
    });
    return attempt.status === "succeeded" && !completeSuccess;
  }
}
