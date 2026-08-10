import Stripe from "stripe";
import { env } from "../../config/env";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-07-30.basil",
});

export class StripeSubscriptionService {
  async create(params: {
    customerId: string;
    priceAmount: number;
    currency: string;
    interval: number;
    intervalType: "day" | "week" | "month" | "year";
    paymentMethodId?: string;
    metadata?: Record<string, string>;
  }) {
    const price = await stripe.prices.create({
      unit_amount: params.priceAmount,
      currency: params.currency.toLowerCase(),
      recurring: {
        interval: params.intervalType,
        interval_count: params.interval,
      },
      product_data: {
        name: params.metadata?.productName || "Assinatura",
      },
    });

    const subscriptionData: Stripe.SubscriptionCreateParams = {
      customer: params.customerId,
      items: [{ price: price.id }],
      metadata: params.metadata || {},
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    };

    if (params.paymentMethodId) {
      subscriptionData.default_payment_method = params.paymentMethodId;
      subscriptionData.payment_behavior = "allow_incomplete";
    }

    const subscription = await stripe.subscriptions.create(subscriptionData);

    return {
      externalId: subscription.id,
      customerId: subscription.customer as string,
      paymentMethodId: params.paymentMethodId,
      status: subscription.status,
      currentPeriodStart: new Date(subscription.current_period_start * 1000),
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    };
  }

  async cancel(subscriptionId: string) {
    return stripe.subscriptions.cancel(subscriptionId);
  }

  async retrieve(subscriptionId: string) {
    return stripe.subscriptions.retrieve(subscriptionId);
  }
}