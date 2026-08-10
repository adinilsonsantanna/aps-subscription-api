import Stripe from "stripe";
import { env } from "../../config/env";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-07-30.basil",
});

export class StripeWebhookService {
    constructEvent(payload: string | Buffer, signature: string) {
        return stripe.webhooks.constructEvent(
            payload,
            signature,
            env.STRIPE_WEBHOOK_SECRET
        );
    }

    async handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
        console.log("[Stripe Webhook] Pagamento bem-sucedido:", invoice.id);
        return {
            invoiceId: invoice.id,
            subscriptionId: invoice.subscription,
            amount: invoice.amount_paid / 100,
            status: "paid",
        };
    }

    async handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
        console.log("[Stripe Webhook] Pagamento falhou:", invoice.id);
        return {
            invoiceId: invoice.id,
            subscriptionId: invoice.subscription,
            status: "failed",
        };
    }

    async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
        console.log("[Stripe Webhook] Assinatura cancelada:", subscription.id);
        return {
            subscriptionId: subscription.id,
            status: "canceled",
        };
    }
}