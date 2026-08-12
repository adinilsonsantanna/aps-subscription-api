import { Router, raw } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

// Shopify webhook precisa do body RAW para validar HMAC.
router.post(
    "/shopify",
    raw({ type: "application/json" }),
    controller.shopify.bind(controller)
);

// Stripe webhook é tratado separadamente em api/webhooks/stripe.ts.
export default router;