import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
    apiVersion: "2025-02-24.acacia",
});

const prisma = new PrismaClient();

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
        const stripeObject = event.data.object as any;

        // DEBUG: mostra todas as chaves do objeto
        console.log("[Stripe Webhook] Objeto keys:", Object.keys(stripeObject));
        console.log("[Stripe Webhook] metadata:", JSON.stringify(stripeObject.metadata));
        console.log("[Stripe Webhook] subscription:", stripeObject.subscription);
        console.log("[Stripe Webhook] customer:", stripeObject.customer);

        let shopDomain: string | undefined = stripeObject.metadata?.shopDomain;
        console.log("[Stripe Webhook] shopDomain do objeto:", shopDomain);

        // Se nao estiver no metadata direto, tenta buscar na subscription
        if (!shopDomain && stripeObject.subscription) {
            const subId = typeof stripeObject.subscription === "string"
                ? stripeObject.subscription
                : stripeObject.subscription.id;
            console.log("[Stripe Webhook] Buscando subscription:", subId);

            try {
                const subscription = await stripe.subscriptions.retrieve(subId);
                console.log("[Stripe Webhook] Subscription metadata:", JSON.stringify(subscription.metadata));
                shopDomain = subscription.metadata?.shopDomain;
                console.log("[Stripe Webhook] shopDomain da subscription:", shopDomain);
            } catch (subErr: any) {
                console.warn("[Stripe Webhook] Erro ao buscar subscription:", subErr.message);
            }
        }

        // Se ainda nao achou, tenta pelo customer
        if (!shopDomain && stripeObject.customer) {
            const custId = typeof stripeObject.customer === "string"
                ? stripeObject.customer
                : stripeObject.customer.id;
            console.log("[Stripe Webhook] Buscando customer:", custId);

            try {
                const customer = await stripe.customers.retrieve(custId);
                if (!customer.deleted) {
                    console.log("[Stripe Webhook] Customer metadata:", JSON.stringify(customer.metadata));
                    shopDomain = customer.metadata?.shopDomain;
                    console.log("[Stripe Webhook] shopDomain do customer:", shopDomain);
                }
            } catch (custErr: any) {
                console.warn("[Stripe Webhook] Erro ao buscar customer:", custErr.message);
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
            console.warn("[Stripe Webhook] shopDomain nao presente em nenhum lugar");
        }

        // Usa upsert para evitar erro de duplicado
        await prisma.webhookEvent.upsert({
            where: { eventId: event.id },
            update: {
                shopId,
                topic: event.type,
                payload: stripeObject,
                processed: false,
            },
            create: {
                shopId,
                source: "stripe",
                eventId: event.id,
                topic: event.type,
                payload: stripeObject,
            },
        });
        console.log("[Stripe Webhook] Evento salvo/atualizado no banco!");
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