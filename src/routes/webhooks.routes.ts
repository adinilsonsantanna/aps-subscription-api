// src/routes/webhooks.routes.ts
import { Router, raw } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

// Shopify webhook usa JSON normal
router.post("/shopify", controller.shopify.bind(controller));

// Stripe webhook PRECISA do body RAW para validar assinatura
router.post("/stripe", raw({ type: "application/json" }), controller.stripe.bind(controller));

export default router;