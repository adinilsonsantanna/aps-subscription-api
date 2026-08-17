import { Prisma, PrismaClient, Subscription } from "@prisma/client";
import Stripe from "stripe";

const TERMINAL = new Set(["cancelled", "expired", "failed"]);
export interface StripeReconciliation { operationalStatus?: string; paymentStatus?: "succeeded" | "failed" | "challenged"; externalId?: string; invoiceId?: string }

function invoiceSubscriptionId(invoice: Stripe.Invoice) {
  if (typeof invoice.subscription === "string") return invoice.subscription;
  return (invoice as unknown as { parent?: { subscription_details?: { subscription?: string } } | null }).parent?.subscription_details?.subscription;
}

export function reconciliationForStripeEvent(event: Stripe.Event): StripeReconciliation | null {
  if (event.type.startsWith("customer.subscription.")) {
    const value = event.data.object as Stripe.Subscription;
    const operationalStatus = value.pause_collection || value.status === "paused" ? "paused" : value.status === "canceled" ? "cancelled" : value.status === "incomplete_expired" ? "expired" : value.status === "unpaid" ? "failed" : value.status === "active" || value.status === "trialing" ? "active" : undefined;
    return { externalId: value.id, operationalStatus };
  }
  if (["invoice.payment_failed", "invoice.payment_succeeded", "invoice.payment_action_required"].includes(event.type)) {
    const invoice = event.data.object as Stripe.Invoice;
    return { externalId: invoiceSubscriptionId(invoice), invoiceId: invoice.id, paymentStatus: event.type === "invoice.payment_failed" ? "failed" : event.type === "invoice.payment_succeeded" ? "succeeded" : "challenged" };
  }
  return null;
}

export function safeStripePatch(subscription: Pick<Subscription, "status" | "lastGatewayEventAt">, event: Stripe.Event, reconciliation: StripeReconciliation) {
  const current = String(subscription.status || "").toLowerCase();
  const eventAt = Number.isFinite(event.created) && event.created > 0 ? new Date(event.created * 1000) : undefined;
  const stale = Boolean(eventAt && subscription.lastGatewayEventAt && eventAt <= subscription.lastGatewayEventAt);
  let next = reconciliation.operationalStatus;
  if (next && TERMINAL.has(current) && !TERMINAL.has(next)) next = undefined;
  if (stale || (!eventAt && next && !TERMINAL.has(next))) next = undefined;
  return { ...(next ? { status: next } : {}), ...(reconciliation.paymentStatus ? { lastPaymentStatus: reconciliation.paymentStatus } : {}), ...(eventAt && !stale ? { lastGatewayEventAt: eventAt } : {}) };
}

export class StripeEventProcessor {
  constructor(private readonly prisma = new PrismaClient()) {}
  async process(event: Stripe.Event) {
    const reconciliation = reconciliationForStripeEvent(event);
    if (!reconciliation?.externalId) return { processed: false, ignored: true };
    const subscription = await this.prisma.subscription.findFirst({ where: { externalId: reconciliation.externalId, gateway: "stripe" } });
    if (!subscription) return { processed: false, ignored: true };
    const existing = await this.prisma.webhookEvent.findUnique({ where: { eventId: event.id }, select: { processed: true } });
    if (existing?.processed) return { processed: true, duplicate: true };
    if (!existing) try {
      await this.prisma.webhookEvent.create({ data: { shopId: subscription.shopId, source: "stripe", eventId: event.id, topic: event.type, payload: { eventId: event.id, type: event.type, created: event.created }, processed: false } });
    } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error; }
    const patch = safeStripePatch(subscription, event, reconciliation);
    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.subscription.update({ where: { id: subscription.id }, data: patch });
      if (reconciliation.invoiceId && reconciliation.paymentStatus) {
        const attempt = await tx.subscriptionOrder.findFirst({ where: { gatewayOrderId: reconciliation.invoiceId, subscriptionId: subscription.id } });
        if (!attempt) await tx.subscriptionOrder.create({ data: { subscriptionId: subscription.id, gatewayOrderId: reconciliation.invoiceId, amount: 0, status: reconciliation.paymentStatus, processedAt: new Date() } });
      }
      await tx.subscriptionStatusHistory.upsert({ where: { source_sourceEventId: { source: "stripe_webhook", sourceEventId: event.id } }, create: { subscriptionId: subscription.id, previousStatus: subscription.status, newStatus: (patch as { status?: string }).status || subscription.status || "active", previousPaymentStatus: subscription.lastPaymentStatus, newPaymentStatus: reconciliation.paymentStatus || subscription.lastPaymentStatus, source: "stripe_webhook", sourceEventId: event.id }, update: {} });
      await tx.webhookEvent.update({ where: { eventId: event.id }, data: { processed: true, processedAt: new Date(), errorMessage: null } });
    });
    return { processed: true, duplicate: false };
  }
}
