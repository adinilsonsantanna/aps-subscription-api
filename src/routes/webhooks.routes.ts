import { Router, raw } from "express";
import { WebhookController } from "../controllers/WebhookController";
import { StripeWebhookController } from "../controllers/StripeWebhookController";
import { ResendWebhookController } from "../controllers/ResendWebhookController";

const router = Router();
const controller = new WebhookController();
const stripeController = new StripeWebhookController();
const resendController = new ResendWebhookController();

// Shopify webhook precisa do body RAW para validar HMAC.
router.post(
    "/shopify",
    raw({ type: "application/json" }),
    controller.shopify.bind(controller)
);

// Stripe webhook é tratado separadamente em api/webhooks/stripe.ts.
router.post("/stripe", raw({ type: "application/json" }), stripeController.handle.bind(stripeController));
router.post("/resend", raw({ type: "application/json", limit: "1mb" }), resendController.handle.bind(resendController));

export default router;
