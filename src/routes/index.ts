// src/routes/index.ts
import { Router } from "express";
import installRoutes from "./install.routes";
import subscriptionRoutes from "./subscriptions.routes";
import webhookRoutes from "./webhooks.routes";
import healthRoutes from "./health.routes";        // ← ADICIONAR
import { apiAuth } from "../middlewares/apiAuth";

const router = Router();

// Rota pública (health check básico)
router.get("/", (_, res) => {
    res.json({
        status: "OK",
        service: "APS Subscription API - Central",
    });
});

// 🔍 Health check detalhado (público)          // ← ADICIONAR
router.use("/health", healthRoutes);              // ← ADICIONAR

// 🔒 Rotas protegidas
router.use("/api/shop", apiAuth, installRoutes);
router.use("/api/subscriptions", apiAuth, subscriptionRoutes);

// Webhooks
router.use("/api/webhooks", webhookRoutes);

export default router;