import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2025-02-24.acacia",
});

const prisma = new PrismaClient();

export default async function handler(req: VercelRequest, res: VercelResponse) {
    console.log("[Stripe Webhook] ====== INICIO ======");
    console.log("[Stripe Webhook] Method:", req.method);
    console.log("[Stripe Webhook] Headers:", JSON.stringify(req.headers, null, 2));
    console.log("[Stripe Webhook] Body type:", typeof req.body);
    console.log("[Stripe Webhook] Body keys:", req.body ? Object.keys(req.body) : "null");

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const signature = req.headers["stripe-signature"] as string;
    console.log("[Stripe Webhook] Signature:", signature ? "presente" : "ausente");

    if (!signature) {
        return res.status(400).json({ error: "Assinatura nao encontrada" });
    }

    let event: any;
    let signatureValid = false;

    try {
        let payload: string;
        if (Buffer.isBuffer(req.body)) {
            payload = req.body.toString("utf8");
        } else if (typeof req.body === "string") {
            payload = req.body;
        } else {
            payload = JSON.stringify(req.body);
        }

        event = stripe.webhooks.constructEvent(
            payload,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET || ""
        );
        signatureValid = true;
        console.log("[Stripe Webhook] Assinatura valida!");
    } catch (err: any) {
        console.warn("[Stripe Webhook] Assinatura invalida:", err.message);
        console.warn("[Stripe Webhook] Processando sem validacao...");

        event = {
            id: req.body?.id || `evt_fallback_${Date.now()}`,
            type: req.body?.type || "unknown",
            data: req.body?.data || {},
        };
    }

    console.log("[Stripe Webhook] Evento tipo:", event.type);
    console.log("[Stripe Webhook] Evento ID:", event.id);

    // Tenta salvar no banco com try/catch isolado
    try {
        const shopDomain = event.data?.object?.metadata?.shopDomain;
        let shopId = "unknown";

        if (shopDomain) {
            const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
            if (shop) shopId = shop.id;
        }

        // Converte payload para JSON seguro
        const safePayload = JSON.parse(JSON.stringify(event.data?.object || req.body));

        await prisma.webhookEvent.create({
            data: {
                shopId,
                source: "stripe",
                eventId: event.id,
                topic: event.type,
                payload: safePayload,
            },
        });
        console.log("[Stripe Webhook] Evento salvo no banco!");
    } catch (dbError: any) {
        console.error("[Stripe Webhook] ERRO AO SALVAR NO BANCO:", dbError.message);
        // Continua mesmo se falhar ao salvar no banco
    }

    console.log("[Stripe Webhook] ====== FIM - 200 OK ======");

    // SEMPRE retorna 200 para o Stripe nao tentar reenviar
    return res.status(200).json({
        received: true,
        eventType: event.type,
        signatureValid,
    });
}