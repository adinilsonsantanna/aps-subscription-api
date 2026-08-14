import { Prisma, PrismaClient } from "@prisma/client";
import { StripeSubscriptionService } from "../gateways/stripe/stripe-subscription.service";

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
    if (existing) {
      if (existing.action !== action) throw new LifecycleError(409, "idempotency_conflict", "Idempotency key was used for another action");
      if (existing.status === "succeeded") return this.response(existing, true);
      throw new LifecycleError(409, "action_in_progress", "Lifecycle action is already pending or failed");
    }
    if (action === "cancel" && current === "cancelled") return { success: true, duplicate: true, action, gateway: subscription.gateway, status: "cancelled" };
    const pending = await this.prisma.subscriptionLifecycleAction.findFirst({ where: { subscriptionId, status: "pending" } });
    if (pending) throw new LifecycleError(409, "action_in_progress", "Another lifecycle action is pending");

    let record;
    try {
      record = await this.prisma.subscriptionLifecycleAction.create({ data: { subscriptionId, idempotencyKey, action, gateway: subscription.gateway, actor, status: "pending" } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new LifecycleError(409, "action_in_progress", "Lifecycle action is already pending");
      throw error;
    }

    try {
      const externalStatus = subscription.gateway === "shopify"
        ? await this.executeShopify(subscription.shop.domain, subscription.shopifyContractId, action, actor, idempotencyKey)
        : await this.executeStripe(subscription.externalId, action);
      const targetStatus = TARGET[action];
      const updateStatus = subscription.gateway === "stripe";
      const completed = await this.prisma.$transaction(async (tx) => {
        const updatedAction = await tx.subscriptionLifecycleAction.update({ where: { id: record.id }, data: { status: "succeeded", externalStatus, completedAt: new Date() } });
        if (updateStatus) await tx.subscription.update({ where: { id: subscriptionId }, data: { status: targetStatus } });
        await tx.subscriptionStatusHistory.create({ data: { subscriptionId, previousStatus: subscription.status, newStatus: updateStatus ? targetStatus : (subscription.status || targetStatus), source: "lifecycle_action", sourceEventId: `lifecycle:${record.id}`, lifecycleActionId: record.id, actor } });
        return updatedAction;
      });
      return this.response(completed, false);
    } catch (error) {
      const safe = error instanceof LifecycleError ? error : new LifecycleError(502, "external_gateway_error", "External gateway request failed");
      await this.prisma.subscriptionLifecycleAction.update({ where: { id: record.id }, data: { status: "failed", errorCode: safe.code, errorMessage: safe.message.slice(0, 250), completedAt: new Date() } });
      throw safe;
    }
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
