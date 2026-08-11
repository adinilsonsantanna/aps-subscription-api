import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2025-02-24.acacia",
});

const prisma = new PrismaClient();

/**
 * Lê o body raw (buffer) do request stream.
 * Necessário porque o Vercel parseia JSON automaticamente,
 * mas a Stripe exige o body exato (byte-a-byte) para validar a assinatura.
 */
async function getRawBody(req: VercelRequest): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    console.log("[Stripe Webhook] ====== INICIO ======");
    console.log("[Stripe Webhook] Method:", req.method);

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const signature = req.headers["stripe-signature"] as string;
    console.log("[Stripe Webhook] Signature:", signature ? "presente" : "ausente");

    if (!signature) {
        return res.status(400).json({ error: "Assinatura nao encontrada" });
    }

    let event: Stripe.Event;

    try {
        const payload = await getRawBody(req);
        console.log("[Stripe Webhook] Payload length:", payload.length);

        event = stripe.webhooks.constructEvent(
            payload,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET || ""
        );
        console.log("[Stripe Webhook] Assinatura valida!");
    } catch (err: any) {
        console.error("[Stripe Webhook] Assinatura invalida:", err.message);
        return res.status(400).json({
            error: "Assinatura invalida",
            message: err.message,
        });
    }

    console.log("[Stripe Webhook] Evento tipo:", event.type);
    console.log("[Stripe Webhook] Evento ID:", event.id);

    try {
        // Cast para any porque event.data.object é um union type do Stripe
        // e nem todos os tipos possuem metadata. Usamos any para acessar dinamicamente.
        const stripeObject = event.data.object as any;
        let shopDomain: string | undefined = stripeObject.metadata?.shopDomain;

        // Se nao estiver no metadata direto, tenta buscar na subscription (para eventos de invoice)
        if (!shopDomain && stripeObject.subscription) {
            console.log("[Stripe Webhook] Buscando subscription:", stripeObject.subscription);
            try {
                const subscription = await stripe.subscriptions.retrieve(
                    typeof stripeObject.subscription === "string"
                        ? stripeObject.subscription
                        : stripeObject.subscription.id
                );
                shopDomain = subscription.metadata?.shopDomain;
                console.log("[Stripe Webhook] shopDomain da subscription:", shopDomain);
            } catch (subErr: any) {
                console.warn("[Stripe Webhook] Erro ao buscar subscription:", subErr.message);
            }
        }

        let shopId: string | null = null;

        if (shopDomain) {
            const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
            if (shop) {
                shopId = shop.id;
                console.log("[Stripe Webhook] Shop encontrado:", shopId);
            } else {
                console.warn("[Stripe Webhook] Shop nao encontrado para domain:", shopDomain);
            }
        } else {
            console.warn("[Stripe Webhook] shopDomain nao presente no metadata");
        }

        await prisma.webhookEvent.create({
            data: {
                shopId,
                source: "stripe",
                eventId: event.id,
                topic: event.type,
                payload: stripeObject,
            },
        });
        console.log("[Stripe Webhook] Evento salvo no banco!");
    } catch (dbError: any) {
        console.error("[Stripe Webhook] ERRO AO SALVAR NO BANCO:", dbError.message);
        return res.status(500).json({
            error: "Erro ao salvar evento",
            message: dbError.message,
        });
    }

    console.log("[Stripe Webhook] ====== FIM - 200 OK ======");

    return res.status(200).json({
        received: true,
        eventType: event.type,
    });
}