import Stripe from "stripe";

export interface HistoricalStripeSubscription {
  id: string;
  externalId: string | null;
  shopifyVariantId: string | null;
  shop: { domain: string } | null;
}

export interface RecurringShopifyOrderCreator {
  create(subscription: HistoricalStripeSubscription, invoice: Stripe.Invoice): Promise<string>;
}

function variantGid(value: string) {
  return value.startsWith("gid://shopify/ProductVariant/") ? value : `gid://shopify/ProductVariant/${value}`;
}

export class AppShopifyRecurringOrderService implements RecurringShopifyOrderCreator {
  async create(subscription: HistoricalStripeSubscription, invoice: Stripe.Invoice): Promise<string> {
    if (!subscription.shop?.domain) throw new Error("Subscription shop is unavailable");
    if (!subscription.shopifyVariantId) throw new Error("Subscription Shopify variant is unavailable");
    if (!invoice.id || !Number.isFinite(invoice.amount_paid) || invoice.amount_paid < 0) throw new Error("Successful Stripe invoice has an invalid paid amount");

    const baseUrl = process.env.SHOPIFY_APP_URL;
    const apiKey = process.env.API_KEY;
    if (!baseUrl || !apiKey) throw new Error("Shopify App integration is not configured");

    const amount = (invoice.amount_paid / 100).toFixed(2);
    const currency = String(invoice.currency).toUpperCase();
    const customerDetails = (invoice as unknown as { customer_details?: { name?: string | null; email?: string | null; phone?: string | null; address?: Stripe.Address | null } }).customer_details;
    const name = invoice.customer_name || customerDetails?.name || undefined;
    const parts = name?.trim().split(/\s+/) ?? [];
    const firstName = parts.shift();
    const lastName = parts.length ? parts.join(" ") : undefined;
    const email = invoice.customer_email || customerDetails?.email || undefined;
    const phone = invoice.customer_phone || customerDetails?.phone || undefined;
    const address = invoice.customer_shipping?.address || customerDetails?.address;
    const postalAddress = address ? { firstName, lastName, address1: address.line1 || undefined, address2: address.line2 || undefined, city: address.city || undefined, province: address.state || undefined, countryCode: address.country || undefined, zip: address.postal_code || undefined } : undefined;
    const order: Record<string, unknown> = {
      lineItems: [{ variantId: variantGid(subscription.shopifyVariantId), quantity: 1, priceSet: { shopMoney: { amount, currencyCode: currency } }, properties: [{ name: "_aps_subscription", value: "true" }, { name: "_aps_subscription_id", value: subscription.id }, { name: "_stripe_invoice_id", value: invoice.id }] }],
      financialStatus: "PAID",
      currency,
      presentmentCurrency: currency,
      email,
      phone,
      customer: { toUpsert: { email, firstName, lastName, phone } },
      note: `APS Subscription ${subscription.id} - Recorrência Stripe - Invoice ${invoice.id}`,
      customAttributes: [{ key: "APS Subscription ID", value: subscription.id }, { key: "Stripe Invoice ID", value: invoice.id }, { key: "Stripe Subscription ID", value: subscription.externalId || "" }],
      processedAt: new Date((invoice.status_transitions?.paid_at || invoice.created || 0) * 1000).toISOString(),
      transactions: [{ kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount, currencyCode: currency } } }],
      ...(postalAddress ? { shippingAddress: postalAddress, billingAddress: postalAddress } : {}),
    };

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/shopify/create-recurring-order`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey, "Idempotency-Key": `stripe-invoice:${invoice.id}` }, body: JSON.stringify({ shop: subscription.shop.domain, order }) });
    if (!response.ok) throw new Error(`Shopify App API error: ${response.status} - ${await response.text()}`);
    const result = await response.json() as { order?: { id?: string } };
    if (!result.order?.id) throw new Error("Shopify App did not return an order ID");
    return result.order.id;
  }
}
