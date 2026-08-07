// src/routes/index.ts
// Rotas principais da API Central com middleware de autenticação

import { Router } from "express";
import installRoutes from "./install.routes";
import subscriptionRoutes from "./subscriptions.routes";
import webhookRoutes from "./webhooks.routes";
import { apiAuth } from "../middlewares/apiAuth";

const router = Router();

// Rota pública (health check)
router.get("/", (_, res) => {
    res.json({
        status: "OK",
        service: "APS Subscription API - Central",
    });
});

// 🔒 Rotas protegidas pelo middleware apiAuth
// Apenas o App Shopify autorizado pode acessar
router.use("/api/shop", apiAuth, installRoutes);
router.use("/api/subscriptions", apiAuth, subscriptionRoutes);

// Webhooks do Shopify e Mercado Pago têm autenticação própria
router.use("/api/webhooks", webhookRoutes);

export default router;