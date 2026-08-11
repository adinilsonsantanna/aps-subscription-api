// src/routes/webhooks.routes.ts
import { Router } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

// Shopify webhook (continua pelo Express)
router.post("/shopify", controller.shopify.bind(controller));

// ⚠️ Stripe webhook AGORA É UM ENDPOINT SERVERLESS SEPARADO
// em api/webhooks/stripe.ts — NÃO passe pelo Express!
// router.post("/stripe", ...);  ← REMOVIDO

export default router;