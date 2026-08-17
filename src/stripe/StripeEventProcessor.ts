import { Prisma, PrismaClient, Subscription } from "@prisma/client";
import Stripe from "stripe";
import { AppShopifyRecurringOrderService, RecurringShopifyOrderCreator } from "./RecurringShopifyOrderService";

const TERMINAL = new Set(["cancelled", "expired", "failed"]);
const INVOICE_EVENTS = new Set(["invoice.payment_failed", "invoice.payment_succeeded", "invoice.payment_action_required"]);
export interface StripeReconciliation { operationalStatus?: string; paymentStatus?: "succeeded" | "failed" | "challenged"; externalId?: string; invoiceId?: string }

function invoiceSubscriptionId(invoice: Stripe.Invoice) {
  if (typeof invoice.subscription === "string") return invoice.subscription;
  return (invoice as unknown as { parent?: { subscription_details?: { subscription?: string } } | null }).parent?.subscription_details?.subscription;
}

function nextBillingAt(invoice: Stripe.Invoice) {
  const ends = invoice.lines?.data.map((line) => line.period?.end).filter((value): value is number => Number.isFinite(value) && Number(value) > 0) ?? [];
  const legacyPeriodEnd = (invoice as unknown as { period_end?: number }).period_end;
  if (Number.isFinite(legacyPeriodEnd) && Number(legacyPeriodEnd) > 0) ends.push(Number(legacyPeriodEnd));
  return ends.length ? new Date(Math.max(...ends) * 1000) : undefined;
}

export function reconciliationForStripeEvent(event: Stripe.Event): StripeReconciliation | null {
  if (event.type.startsWith("customer.subscription.")) {
    const value = event.data.object as Stripe.Subscription;
    const operationalStatus = value.pause_collection || value.status === "paused" ? "paused" : value.status === "canceled" ? "cancelled" : value.status === "incomplete_expired" ? "expired" : value.status === "unpaid" ? "failed" : value.status === "active" || value.status === "trialing" ? "active" : undefined;
    return { externalId: value.id, operationalStatus };
  }
  if (INVOICE_EVENTS.has(event.type)) {
    const invoice = event.data.object as Stripe.Invoice;
    return { externalId: invoiceSubscriptionId(invoice), invoiceId: invoice.id, paymentStatus: event.type === "invoice.payment_failed" ? "failed" : event.type === "invoice.payment_succeeded" ? "succeeded" : "challenged" };
  }
  return null;
}

export function safeStripePatch(subscription: Pick<Subscription, "status" | "lastGatewayStatusEventAt" | "lastGatewayPaymentEventAt">, event: Stripe.Event, reconciliation: StripeReconciliation) {
  const current = String(subscription.status || "").toLowerCase();
  const eventAt = Number.isFinite(event.created) && event.created > 0 ? new Date(event.created * 1000) : undefined;
  const isStatusEvent = reconciliation.operationalStatus !== undefined;
  const isPaymentEvent = reconciliation.paymentStatus !== undefined;
  const statusStale = Boolean(isStatusEvent && eventAt && subscription.lastGatewayStatusEventAt && eventAt <= subscription.lastGatewayStatusEventAt);
  const paymentStale = Boolean(isPaymentEvent && eventAt && subscription.lastGatewayPaymentEventAt && eventAt <= subscription.lastGatewayPaymentEventAt);
  let next = reconciliation.operationalStatus;
  if (next && TERMINAL.has(current) && !TERMINAL.has(next)) next = undefined;
  if (statusStale || (!eventAt && next && !TERMINAL.has(next))) next = undefined;
  return {
    ...(next ? { status: next } : {}),
    ...(isPaymentEvent && !paymentStale ? { lastPaymentStatus: reconciliation.paymentStatus } : {}),
    ...(isStatusEvent && eventAt && !statusStale ? { lastGatewayStatusEventAt: eventAt } : {}),
    ...(isPaymentEvent && eventAt && !paymentStale ? { lastGatewayPaymentEventAt: eventAt } : {}),
  };
}

export class StripeEventProcessor {
  constructor(private readonly prisma = new PrismaClient(), private readonly recurringOrders: RecurringShopifyOrderCreator = new AppShopifyRecurringOrderService()) {}

  async process(event: Stripe.Event) {
    const reconciliation = reconciliationForStripeEvent(event);
    if (!reconciliation?.externalId) return { processed: false, ignored: true };
    const subscription = await this.prisma.subscription.findFirst({ where: { externalId: reconciliation.externalId, gateway: "stripe" }, include: { shop: true } });
    if (!subscription) return { processed: false, ignored: true };
    const existingEvent = await this.prisma.webhookEvent.findUnique({ where: { eventId: event.id }, select: { processed: true } });
    if (existingEvent?.processed) return { processed: true, duplicate: true };
    if (!existingEvent) try {
      await this.prisma.webhookEvent.create({ data: { shopId: subscription.shopId, source: "stripe", eventId: event.id, topic: event.type, payload: { eventId: event.id, type: event.type, created: event.created }, processed: false } });
    } catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error; }

    const patch: Prisma.SubscriptionUpdateInput = safeStripePatch(subscription, event, reconciliation);
    const invoice = INVOICE_EVENTS.has(event.type) ? event.data.object as Stripe.Invoice : undefined;
    const existingOrder = invoice?.id ? await this.prisma.subscriptionOrder.findFirst({ where: { gatewayOrderId: invoice.id, subscriptionId: subscription.id } }) : null;
    let shopifyOrderId = existingOrder?.shopifyOrderId ?? undefined;
    if (event.type === "invoice.payment_succeeded" && invoice) {
      if (!invoice.amount_paid || invoice.amount_paid <= 0) throw new Error("Successful Stripe invoice has no paid amount");
      const recurring = invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_threshold";
      if (recurring && process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW === "true" && !shopifyOrderId) shopifyOrderId = await this.recurringOrders.create(subscription, invoice);
      const billingAt = nextBillingAt(invoice);
      if (billingAt && "lastPaymentStatus" in patch && (!subscription.nextBillingAt || billingAt > subscription.nextBillingAt)) patch.nextBillingAt = billingAt;
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.subscription.update({ where: { id: subscription.id }, data: patch });
      if (invoice?.id && reconciliation.paymentStatus) {
        const orderData = { shopifyOrderId, amount: event.type === "invoice.payment_succeeded" ? invoice.amount_paid / 100 : 0, currency: invoice.currency ? invoice.currency.toUpperCase() : null, status: event.type === "invoice.payment_succeeded" ? "paid" : reconciliation.paymentStatus, processedAt: new Date() };
        if (existingOrder) await tx.subscriptionOrder.update({ where: { id: existingOrder.id }, data: orderData });
        else await tx.subscriptionOrder.create({ data: { subscriptionId: subscription.id, gatewayOrderId: invoice.id, ...orderData } });
      }
      await tx.subscriptionStatusHistory.upsert({ where: { source_sourceEventId: { source: "stripe_webhook", sourceEventId: event.id } }, create: { subscriptionId: subscription.id, previousStatus: subscription.status, newStatus: (patch as { status?: string }).status || subscription.status || "active", previousPaymentStatus: subscription.lastPaymentStatus, newPaymentStatus: (patch as { lastPaymentStatus?: string }).lastPaymentStatus || subscription.lastPaymentStatus, source: "stripe_webhook", sourceEventId: event.id }, update: {} });
      await tx.webhookEvent.update({ where: { eventId: event.id }, data: { processed: true, processedAt: new Date(), errorMessage: null } });
    });
    return { processed: true, duplicate: false };
  }
}
