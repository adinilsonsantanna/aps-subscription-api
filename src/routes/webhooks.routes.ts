// src/routes/webhooks.routes.ts
// Rotas para receber webhooks do Shopify e Mercado Pago

import { Router } from "express";
import { WebhookController } from "../controllers/WebhookController";

const router = Router();
const controller = new WebhookController();

// POST /api/webhooks/shopify - Webhooks do Shopify
router.post("/shopify", controller.shopify.bind(controller));

// POST /api/webhooks/mercado-pago - Webhooks do Mercado Pago
router.post("/mercado-pago", controller.mercadoPago.bind(controller));

export default router;