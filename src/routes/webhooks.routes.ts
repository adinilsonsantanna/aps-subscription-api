// src/routes/webhooks.routes.ts
// Rotas para receber webhooks do Shopify e Stripe

import { Router } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

// POST /api/webhooks/shopify - Webhooks do Shopify
router.post("/shopify", controller.shopify.bind(controller));

// POST /api/webhooks/stripe - Webhooks do Stripe
router.post("/stripe", controller.stripe.bind(controller));

export default router;