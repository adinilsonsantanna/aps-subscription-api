import Stripe from "stripe";
import { env } from "../../config/env";

const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
});

export class StripeWebhookService {
    constructEvent(payload: string | Buffer, signature: string) {
        return stripe.webhooks.constructEvent(
            payload,
            signature,
            env.STRIPE_WEBHOOK_SECRET
        );
    }
}
