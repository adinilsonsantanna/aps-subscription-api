// api/webhooks/stripe.ts
// Handler serverless DIRETO para webhook do Stripe (sem Express)
// Isso garante que o body chegue como string/raw para validar a assinatura

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-07-30.basil",
});

const prisma = new PrismaClient();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const signature = req.headers["stripe-signature"] as string;

  if (!signature) {
    return res.status(400).json({ error: "Assinatura não encontrada" });
  }

  let event: Stripe.Event;

  try {
    // O @vercel/node preserva o body como string para webhooks
    const payload = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err: any) {
    console.error("[Stripe Webhook] Erro na assinatura:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  console.log("[Stripe Webhook] Evento recebido:", event.type, event.id);

  // Salva o evento no banco
  const shopDomain = (event.data.object as any)?.metadata?.shopDomain;
  let shopId = "unknown";

  if (shopDomain) {
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (shop) shopId = shop.id;
  }

  await prisma.webhookEvent.create({
    data: {
      shopId,
      source: "stripe",
      eventId: event.id,
      topic: event.type,
      payload: event.data.object as any,
    },
  });

  // Processa o evento
  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      console.log("[Stripe Webhook] Pagamento bem-sucedido:", invoice.id);

      if (invoice.subscription) {
        const subscription = await prisma.subscription.findFirst({
          where: { externalId: invoice.subscription as string },
        });

        if (subscription) {
          await prisma.subscriptionOrder.create({
            data: {
              subscriptionId: subscription.id,
              gatewayOrderId: invoice.id,
              amount: invoice.amount_paid / 100,
              status: "paid",
              processedAt: new Date(),
            },
          });

          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { nextBillingAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          });
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      console.log("[Stripe Webhook] Pagamento falhou:", invoice.id);

      if (invoice.subscription) {
        const subscription = await prisma.subscription.findFirst({
          where: { externalId: invoice.subscription as string },
        });

        if (subscription) {
          await prisma.subscriptionOrder.create({
            data: {
              subscriptionId: subscription.id,
              gatewayOrderId: invoice.id,
              amount: 0,
              status: "failed",
              processedAt: new Date(),
            },
          });

          await prisma.subscription.update({
            where: { id: subscription.id },
            data: { status: "past_due" },
          });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      console.log("[Stripe Webhook] Assinatura cancelada:", subscription.id);

      const dbSubscription = await prisma.subscription.findFirst({
        where: { externalId: subscription.id },
      });

      if (dbSubscription) {
        await prisma.subscription.update({
          where: { id: dbSubscription.id },
          data: { status: "canceled" },
        });
      }
      break;
    }

    default:
      console.log(`[Stripe Webhook] Evento não processado: ${event.type}`);
  }

  return res.status(200).json({ received: true, eventType: event.type });
}
