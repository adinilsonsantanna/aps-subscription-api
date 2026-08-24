import { Prisma, PrismaClient } from "@prisma/client";
import { StripeSubscriptionService } from "../gateways/stripe/stripe-subscription.service";
import { NotificationEventService } from "../notifications/NotificationEventService";

export type LifecycleActionName = "pause" | "resume" | "cancel";
const TERMINAL = new Set(["cancelled", "expired", "failed"]);
const TARGET: Record<LifecycleActionName, string> = { pause: "paused", resume: "active", cancel: "cancelled" };

export class LifecycleError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}

type Fetch = typeof fetch;
export class SubscriptionLifecycleService {
  constructor(
    private prisma = new PrismaClient(),
    private stripe = new StripeSubscriptionService(),
    private fetchFn: Fetch = fetch,
    private notifications = new NotificationEventService(prisma),
  ) {}

  async execute(subscriptionId: string, action: LifecycleActionName, idempotencyKey: string, actor = "CUSTOMER") {
    if (!idempotencyKey || idempotencyKey.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) throw new LifecycleError(400, "invalid_idempotency_key", "Invalid Idempotency-Key");
    if (!["CUSTOMER", "MERCHANT", "PARTNER"].includes(actor)) throw new LifecycleError(400, "invalid_actor", "Invalid actor");
    const subscription = await this.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { shop: true } });
    if (!subscription) throw new LifecycleError(404, "subscription_not_found", "Subscription not found");
    if (subscription.gateway !== "shopify" && subscription.gateway !== "stripe") throw new LifecycleError(400, "invalid_gateway", "Subscription gateway is missing or invalid");
    const current = (subscription.status || "").toLowerCase();
    if ((action === "resume" && (current === "cancelled" || current === "expired")) || (action === "pause" && TERMINAL.has(current))) throw new LifecycleError(409, "invalid_transition", "Lifecycle transition is not allowed");

    const existing = await this.prisma.subscriptionLifecycleAction.findUnique({ where: { subscriptionId_idempotencyKey: { subscriptionId, idempotencyKey } } });
    if (existing?.action !== undefined && existing.action !== action) throw new LifecycleError(409, "idempotency_conflict", "Idempotency key was used for another action");
    if (existing?.status === "succeeded") return this.response(existing, true);
    if (existing?.status === "external_succeeded") return this.finalizeLocal(existing, subscription, action, actor, true);
    if (existing?.status === "failed" && subscription.gateway !== "shopify") throw new LifecycleError(existing.httpStatus || 502, existing.errorCode || "external_gateway_error", existing.errorMessage || "External gateway request failed");
    if (action === "cancel" && current === "cancelled") return { success: true, duplicate: true, action, gateway: subscription.gateway, status: "cancelled" };
    const pending = !existing && await this.prisma.subscriptionLifecycleAction.findFirst({ where: { subscriptionId, status: "pending" } });
    if (pending) throw new LifecycleError(409, "action_in_progress", "Another lifecycle action is pending");

    let record = existing;
    if (existing) {
      const staleAt = new Date(Date.now() - 60_000);
      const recoverable = existing.status === "failed" || ((existing.status === "pending" || existing.status === "recovering") && existing.updatedAt < staleAt);
      if (!recoverable) throw new LifecycleError(409, "action_in_progress", "Lifecycle action is already pending");
      const claimed = await this.prisma.subscriptionLifecycleAction.updateMany({ where: { id: existing.id, status: existing.status, updatedAt: existing.updatedAt }, data: { status: "recovering", completedAt: null, errorCode: null, errorMessage: null, httpStatus: null } });
      if (!claimed.count) throw new LifecycleError(409, "action_in_progress", "Lifecycle action recovery is already in progress");
      record = { ...existing, status: "recovering" };
    } else try {
      record = await this.prisma.subscriptionLifecycleAction.create({ data: { subscriptionId, idempotencyKey, action, gateway: subscription.gateway, actor, status: "pending" } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const claimed = await this.prisma.subscriptionLifecycleAction.findUnique({ where: { subscriptionId_idempotencyKey: { subscriptionId, idempotencyKey } } });
        if (claimed?.action === action && claimed.status === "succeeded") return this.response(claimed, true);
        if (claimed?.action === action && claimed.status === "external_succeeded") return this.finalizeLocal(claimed, subscription, action, actor, true);
        throw new LifecycleError(409, "action_in_progress", "Another lifecycle action is pending");
      }
      throw error;
    }

    let externalConfirmed = false;
    try {
      const externalStatus = subscription.gateway === "shopify"
        ? await this.executeShopify(subscription.shop.domain, subscription.shopifyContractId, action, actor, idempotencyKey)
        : await this.executeStripe(subscription.externalId, action);
      externalConfirmed = true;
      const marked = await this.prisma.subscriptionLifecycleAction.update({ where: { id: record!.id }, data: { status: "external_succeeded", externalStatus, errorCode: null, errorMessage: null, httpStatus: null, completedAt: null } });
      return await this.finalizeLocal(marked, subscription, action, actor, false);
    } catch (error) {
      const safe = error instanceof LifecycleError ? error : new LifecycleError(502, "external_gateway_error", "External gateway request failed");
      if (externalConfirmed) throw new LifecycleError(503, "local_persistence_pending", "External action succeeded and local reconciliation is pending");
      await this.prisma.subscriptionLifecycleAction.update({ where: { id: record!.id }, data: { status: "failed", errorCode: safe.code, errorMessage: safe.message.slice(0, 250), httpStatus: safe.statusCode, completedAt: new Date() } });
      throw safe;
    }
  }

  private async finalizeLocal(record: { id: string; idempotencyKey?: string; action: string; gateway: string; externalStatus: string | null }, subscription: any, action: LifecycleActionName, actor: string, duplicate: boolean) {
    const targetStatus = TARGET[action], updateStatus = subscription.gateway === "stripe";
    const completed = await this.prisma.$transaction(async (tx) => {
      const updatedAction = await tx.subscriptionLifecycleAction.update({ where: { id: record.id }, data: { status: "succeeded", completedAt: new Date(), errorCode: null, errorMessage: null, httpStatus: null } });
      if (updateStatus) await tx.subscription.update({ where: { id: subscription.id }, data: { status: targetStatus } });
      await tx.subscriptionStatusHistory.upsert({ where: { source_sourceEventId: { source: "lifecycle_action", sourceEventId: `lifecycle:${record.id}` } }, create: { subscriptionId: subscription.id, previousStatus: subscription.status, newStatus: updateStatus ? targetStatus : (subscription.status || targetStatus), source: "lifecycle_action", sourceEventId: `lifecycle:${record.id}`, lifecycleActionId: record.id, actor }, update: {} });
      return updatedAction;
    });
    if (subscription.gateway === "shopify" && (action === "pause" || action === "cancel")) await this.notifications.emit({ shopId: subscription.shopId, eventType: action === "pause" ? "subscription_paused" : "subscription_cancelled", sourceKey: `contract:${subscription.shopifyContractId}:${action === "pause" ? "paused" : "cancelled"}`, payload: { subscriptionId: subscription.id, contractId: subscription.shopifyContractId, status: action === "pause" ? "paused" : "cancelled" }, customerEmail: subscription.shopifyCustomerEmail });
    return this.response(completed, duplicate);
  }

  private response(record: { action: string; gateway: string; externalStatus: string | null }, duplicate: boolean) {
    return { success: true, duplicate, action: record.action, gateway: record.gateway, status: record.externalStatus };
  }

  private async executeShopify(shop: string, contractId: string | null, action: LifecycleActionName, actor: string, requestId: string) {
    if (!contractId || !/^gid:\/\/shopify\/SubscriptionContract\/[A-Za-z0-9_-]+$/.test(contractId)) throw new LifecycleError(400, "invalid_shopify_contract", "Invalid Shopify contract ID");
    const base = process.env.SHOPIFY_APP_URL?.replace(/\/$/, "");
    const apiKey = process.env.SHOPIFY_APP_API_KEY;
    if (!base || !apiKey) throw new LifecycleError(503, "shopify_app_not_configured", "Shopify App integration is not configured");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await this.fetchFn(`${base}/api/shopify/subscription-lifecycle`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ shop, contractId, action, actor, requestId }), signal: controller.signal });
      const body = await response.json() as { success?: boolean; status?: string; error?: { code?: string } };
      if (!response.ok || !body.success || !body.status) throw new LifecycleError(response.status === 503 || response.status === 504 ? 503 : 502, body.error?.code || "shopify_action_failed", "Shopify did not confirm lifecycle action");
      return body.status.toLowerCase();
    } catch (error) {
      if (controller.signal.aborted) throw new LifecycleError(503, "shopify_timeout", "Shopify App request timed out");
      throw error;
    } finally { clearTimeout(timer); }
  }

  private async executeStripe(externalId: string | null, action: LifecycleActionName) {
    if (!externalId || !/^sub_[A-Za-z0-9]+$/.test(externalId)) throw new LifecycleError(400, "invalid_stripe_subscription", "Invalid Stripe subscription ID");
    const subscription = action === "pause" ? await this.stripe.pause(externalId) : action === "resume" ? await this.stripe.resume(externalId) : await this.stripe.cancel(externalId);
    if (!subscription?.id) throw new LifecycleError(502, "stripe_action_failed", "Stripe did not confirm lifecycle action");
    return action === "pause" ? "paused" : action === "resume" ? "active" : "cancelled";
  }
}
