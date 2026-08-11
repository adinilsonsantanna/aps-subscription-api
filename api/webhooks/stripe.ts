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
    let signatureValid = false;

    try {
        // Lê o body RAW antes de qualquer parse
        const payload = await getRawBody(req);
        console.log("[Stripe Webhook] Payload length:", payload.length);

        event = stripe.webhooks.constructEvent(
            payload,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET || ""
        );
        signatureValid = true;
        console.log("[Stripe Webhook] Assinatura valida!");
    } catch (err: any) {
        console.error("[Stripe Webhook] Assinatura invalida:", err.message);
        // NAO processa eventos com assinatura invalida
        return res.status(400).json({
            error: "Assinatura invalida",
            message: err.message,
        });
    }

    console.log("[Stripe Webhook] Evento tipo:", event.type);
    console.log("[Stripe Webhook] Evento ID:", event.id);

    try {
        const shopDomain = event.data?.object?.metadata?.shopDomain as string | undefined;
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
            console.warn("[Stripe Webhook] shopDomain nao presente no metadata do evento");
        }

        await prisma.webhookEvent.create({
            data: {
                shopId,          // pode ser null agora (schema alterado)
                source: "stripe",
                eventId: event.id,
                topic: event.type,
                payload: event.data.object as any,
            },
        });
        console.log("[Stripe Webhook] Evento salvo no banco!");
    } catch (dbError: any) {
        console.error("[Stripe Webhook] ERRO AO SALVAR NO BANCO:", dbError.message);
        // Retorna 500 para que a Stripe tente reenviar depois
        return res.status(500).json({
            error: "Erro ao salvar evento",
            message: dbError.message,
        });
    }

    console.log("[Stripe Webhook] ====== FIM - 200 OK ======");

    return res.status(200).json({
        received: true,
        eventType: event.type,
        signatureValid,
    });
}