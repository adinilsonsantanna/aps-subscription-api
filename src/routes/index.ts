import { Router, json } from "express";
import installRoutes from "./install.routes";
import subscriptionRoutes from "./subscriptions.routes";
import webhookRoutes from "./webhooks.routes";
import healthRoutes from "./health.routes";
import { apiAuth } from "../middlewares/apiAuth";
import shopifyEventRoutes from "./shopify-events.routes";

const router = Router();

router.get("/", (_, res) => {
    res.json({ status: "OK", service: "APS Subscription API - Central" });
});
router.use("/health", healthRoutes);

// Rotas protegidas com JSON parser
router.use("/api/shop", apiAuth, json(), installRoutes);
router.use("/api/subscriptions", apiAuth, json(), subscriptionRoutes);
router.use("/api/shopify", apiAuth, json({ limit: "1mb" }), shopifyEventRoutes);

// Webhooks sem JSON global
router.use("/api/webhooks", webhookRoutes);

export default router;
