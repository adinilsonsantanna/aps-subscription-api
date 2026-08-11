import Stripe from "stripe";
import { env } from "../../config/env";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
});

export class StripeCustomerService {
    async create(email: string, name?: string) {
        return stripe.customers.create({
            email,
            name: name || email,
        });
    }

    async retrieve(customerId: string) {
        return stripe.customers.retrieve(customerId);
    }

    async attachPaymentMethod(customerId: string, paymentMethodId: string) {
        await stripe.paymentMethods.attach(paymentMethodId, {
            customer: customerId,
        });

        await stripe.customers.update(customerId, {
            invoice_settings: {
                default_payment_method: paymentMethodId,
            },
        });
    }
}