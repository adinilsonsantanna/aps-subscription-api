// src/routes/health.routes.ts
// Rota de health check para verificar configurações

import { Router } from "express";

const router = Router();

router.get("/", (_, res) => {
    const stripeSecretConfigured = !!process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.startsWith("sk_");
    const stripeWebhookConfigured = !!process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET.startsWith("whsec_");
    const stripePublishableConfigured = !!process.env.STRIPE_PUBLISHABLE_KEY && process.env.STRIPE_PUBLISHABLE_KEY.startsWith("pk_");
    const databaseConfigured = !!process.env.DATABASE_URL;
    const shopifyConfigured = !!process.env.SHOPIFY_API_KEY && !!process.env.SHOPIFY_API_SECRET;

    const allOk = stripeSecretConfigured && stripeWebhookConfigured && databaseConfigured;

    res.status(allOk ? 200 : 503).json({
        status: allOk ? "OK" : "DEGRADED",
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || "development",
        services: {
            api: "online",
            database: databaseConfigured ? "connected" : "missing_url",
            stripe: {
                secretKey: stripeSecretConfigured ? "configured" : "missing",
                webhookSecret: stripeWebhookConfigured ? "configured" : "missing",
                publishableKey: stripePublishableConfigured ? "configured" : "missing",
            },
            shopify: shopifyConfigured ? "configured" : "missing",
        },
        keysPreview: {
            stripeSecretKey: process.env.STRIPE_SECRET_KEY ? `${process.env.STRIPE_SECRET_KEY.substring(0, 10)}...` : null,
            stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ? `${process.env.STRIPE_WEBHOOK_SECRET.substring(0, 10)}...` : null,
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY ? `${process.env.STRIPE_PUBLISHABLE_KEY.substring(0, 10)}...` : null,
        },
    });
});

export default router;