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
  constructor(
    private readonly prisma = new PrismaClient(),
    private readonly recurringOrders: RecurringShopifyOrderCreator = new AppShopifyRecurringOrderService(),
    private readonly now = () => new Date(),
    private readonly claimLeaseMs = 60_000,
  ) {}

  private async claimInvoiceOrder(subscriptionId: string, invoice: Stripe.Invoice) {
    const claimedAt = this.now();
    const data = {
      subscriptionId,
      gatewayOrderId: invoice.id,
      amount: invoice.amount_paid / 100,
      currencyCode: invoice.currency ? invoice.currency.toUpperCase() : null,
      status: "processing",
      shopifyOrderClaimedAt: claimedAt,
    };
    try {
      return { order: await this.prisma.subscriptionOrder.create({ data }), ownsClaim: true };
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
    let order = await this.prisma.subscriptionOrder.findUnique({ where: { subscriptionId_gatewayOrderId: { subscriptionId, gatewayOrderId: invoice.id } } });
    if (!order) throw new Error("Invoice order claim disappeared");
    if (order.shopifyOrderId) return { order, ownsClaim: false };
    const expiredBefore = new Date(claimedAt.getTime() - this.claimLeaseMs);
    const takeover = await this.prisma.subscriptionOrder.updateMany({ where: { id: order.id, shopifyOrderId: null, status: "processing", OR: [{ shopifyOrderClaimedAt: null }, { shopifyOrderClaimedAt: { lte: expiredBefore } }] }, data: { shopifyOrderClaimedAt: claimedAt } });
    if (takeover.count === 1) {
      order = { ...order, shopifyOrderClaimedAt: claimedAt };
      return { order, ownsClaim: true };
    }
    return { order, ownsClaim: false };
  }

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
    let existingOrder = invoice?.id ? await this.prisma.subscriptionOrder.findUnique({ where: { subscriptionId_gatewayOrderId: { subscriptionId: subscription.id, gatewayOrderId: invoice.id } } }) : null;
    let shopifyOrderId = existingOrder?.shopifyOrderId ?? undefined;
    if (event.type === "invoice.payment_succeeded" && invoice) {
      if (!Number.isFinite(invoice.amount_paid) || invoice.amount_paid < 0) throw new Error("Successful Stripe invoice has an invalid paid amount");
      const recurring = invoice.billing_reason === "subscription_cycle" || invoice.billing_reason === "subscription_threshold";
      if (!existingOrder) {
        const claim = await this.claimInvoiceOrder(subscription.id, invoice);
        existingOrder = claim.order;
        if (recurring && process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW === "true" && !shopifyOrderId) {
          if (!claim.ownsClaim) throw new Error("Stripe invoice fulfillment is already in progress");
          shopifyOrderId = await this.recurringOrders.create(subscription, invoice);
        }
      } else if (recurring && process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW === "true" && !shopifyOrderId) {
        const claim = await this.claimInvoiceOrder(subscription.id, invoice);
        existingOrder = claim.order;
        if (!claim.ownsClaim) throw new Error("Stripe invoice fulfillment is already in progress");
        shopifyOrderId = await this.recurringOrders.create(subscription, invoice);
      }
      const billingAt = nextBillingAt(invoice);
      if (billingAt && "lastPaymentStatus" in patch && (!subscription.nextBillingAt || billingAt > subscription.nextBillingAt)) patch.nextBillingAt = billingAt;
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(patch).length) await tx.subscription.update({ where: { id: subscription.id }, data: patch });
      if (invoice?.id && reconciliation.paymentStatus) {
        const orderData = { shopifyOrderId, amount: event.type === "invoice.payment_succeeded" ? invoice.amount_paid / 100 : 0, currencyCode: invoice.currency ? invoice.currency.toUpperCase() : null, status: event.type === "invoice.payment_succeeded" ? "paid" : reconciliation.paymentStatus, processedAt: this.now() };
        if (existingOrder) await tx.subscriptionOrder.update({ where: { id: existingOrder.id }, data: orderData });
        else await tx.subscriptionOrder.create({ data: { subscriptionId: subscription.id, gatewayOrderId: invoice.id, ...orderData } });
      }
      await tx.subscriptionStatusHistory.upsert({ where: { source_sourceEventId: { source: "stripe_webhook", sourceEventId: event.id } }, create: { subscriptionId: subscription.id, previousStatus: subscription.status, newStatus: (patch as { status?: string }).status || subscription.status || "active", previousPaymentStatus: subscription.lastPaymentStatus, newPaymentStatus: (patch as { lastPaymentStatus?: string }).lastPaymentStatus || subscription.lastPaymentStatus, source: "stripe_webhook", sourceEventId: event.id }, update: {} });
      await tx.webhookEvent.update({ where: { eventId: event.id }, data: { processed: true, processedAt: new Date(), errorMessage: null } });
    });
    return { processed: true, duplicate: false };
  }
}
