import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { WebhookController } from "../../src/controllers/WebhookController";

const stripe = new Stripe(
    process.env.STRIPE_SECRET_KEY || "",
    {
        apiVersion: "2025-02-24.acacia",
    }
);

async function getRawBody(
    req: VercelRequest
): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];

        req.on("data", (chunk) => {
            chunks.push(
                Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk)
            );
        });

        req.on("end", () => {
            resolve(
                Buffer.concat(chunks).toString("utf8")
            );
        });

        req.on("error", reject);
    });
}

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
) {
    console.log(
        "[Stripe Webhook Adapter] ====== INÍCIO ======"
    );

    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method not allowed",
        });
    }

    const signature =
        req.headers["stripe-signature"] as string;

    if (!signature) {
        return res.status(400).json({
            error: "Assinatura não encontrada",
        });
    }

    try {
        // ========================================================
        // VALIDAR PAYLOAD ORIGINAL DA STRIPE
        // ========================================================

        const rawBody =
            await getRawBody(req);

        console.log(
            "[Stripe Webhook Adapter] Payload recebido:",
            rawBody.length
        );

        let event: Stripe.Event;

        try {
            event =
                stripe.webhooks.constructEvent(
                    rawBody,
                    signature,
                    process.env
                        .STRIPE_WEBHOOK_SECRET || ""
                );

            console.log(
                "[Stripe Webhook Adapter] ✅ Assinatura Stripe válida"
            );
        } catch (error) {
            console.error(
                "[Stripe Webhook Adapter] ❌ Assinatura inválida:",
                error
            );

            return res.status(400).json({
                error: "Assinatura inválida",
            });
        }

        console.log(
            "[Stripe Webhook Adapter] Evento:",
            event.type
        );

        console.log(
            "[Stripe Webhook Adapter] Event ID:",
            event.id
        );

        // ========================================================
        // ENTREGAR O EVENTO PARA O CONTROLLER CENTRAL
        // ========================================================

        /*
         * O WebhookController já possui toda a lógica:
         *
         * invoice.payment_succeeded
         *        ↓
         * subscription
         *        ↓
         * billing_reason
         *        ↓
         * createRecurringShopifyOrder()
         *        ↓
         * Shopify orderCreate
         *
         * Portanto esta função NÃO deve duplicar essa lógica.
         */

        const controller =
            new WebhookController();

        /*
         * O controller atual espera req.body.
         * Entregamos o evento já validado pela Stripe.
         */
        (req as any).body =
            event;

        console.log(
            "[Stripe Webhook Adapter] 🚀 Chamando WebhookController.stripe()..."
        );

        await controller.stripe(
            req as any,
            res as any
        );

        console.log(
            "[Stripe Webhook Adapter] ====== FIM ======"
        );

    } catch (error) {
        console.error(
            "[Stripe Webhook Adapter] ❌ ERRO:",
            error
        );

        /*
         * Caso o controller ainda não tenha enviado
         * uma resposta.
         */
        if (!res.headersSent) {
            return res.status(500).json({
                error:
                    "Erro ao processar webhook",
                message:
                    error instanceof Error
                        ? error.message
                        : "Unknown error",
            });
        }
    }
}