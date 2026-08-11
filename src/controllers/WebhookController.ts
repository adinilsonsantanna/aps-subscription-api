// src/controllers/WebhookController.ts
// Controller para processar webhooks do Shopify e Stripe

import { Request, Response } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { StripeWebhookService } from "../gateways/stripe/stripe-webhook.service";

const prisma = new PrismaClient();
const stripeWebhookService = new StripeWebhookService();

export class WebhookController {
  /**
   * Processa webhooks do Shopify
   */
  async shopify(req: Request, res: Response) {
    try {
      const topic = req.headers["x-shopify-topic"] as string;
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const shop = req.headers["x-shopify-shop-domain"] as string;

      const body = JSON.stringify(req.body);
      const hash = crypto
        .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET || "")
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmac) {
        return res.status(401).json({ error: "Assinatura inválida" });
      }

      const shopRecord = await prisma.shop.findUnique({ where: { domain: shop } });
      if (!shopRecord) {
        return res.status(404).json({ error: "Loja não encontrada" });
      }

      await prisma.webhookEvent.create({
        data: {
          shopId: shopRecord.id,
          source: "shopify",
          eventId: req.headers["x-shopify-webhook-id"] as string,
          topic,
          payload: req.body,
        },
      });

      switch (topic) {
        case "subscription_contracts/create":
          await this.handleSubscriptionContractCreate(req.body);
          break;
        case "subscription_contracts/update":
          await this.handleSubscriptionContractUpdate(req.body);
          break;
        case "orders/create":
          await this.handleOrderCreate(req.body, shopRecord.id);
          break;
        default:
          console.log(`[Webhook] Tópico não processado: ${topic}`);
      }

      return res.status(200).send("OK");
    } catch (error) {
      console.error("[WebhookController.shopify]", error);
      return res.status(500).json({ error: "Erro interno" });
    }
  }

  /**
   * Processa webhooks do Stripe
   * Importante: esta rota NÃO deve usar express.json() para preservar o body raw
   */
  async stripe(req: Request, res: Response) {
    try {
      const signature = req.headers["stripe-signature"] as string;

      if (!signature) {
        return res.status(400).json({ error: "Assinatura não encontrada" });
      }

      // Na Vercel, req.body pode vir como Buffer, string ou objeto JSON já parseado
      let payload: string;

      if (Buffer.isBuffer(req.body)) {
        payload = req.body.toString("utf8");
      } else if (typeof req.body === "string") {
        payload = req.body;
      } else if (req.body && typeof req.body === "object") {
        payload = JSON.stringify(req.body);
      } else {
        return res.status(400).json({ error: "Body inválido" });
      }

      const event = stripeWebhookService.constructEvent(payload, signature);

      const shopDomain = event.data.object?.metadata?.shopDomain;
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

      switch (event.type) {
        case "invoice.payment_succeeded": {
          const result = await stripeWebhookService.handleInvoicePaymentSucceeded(
            event.data.object as any
          );

          if (result.subscriptionId) {
            const subscription = await prisma.subscription.findFirst({
              where: { externalId: result.subscriptionId as string },
            });

            if (subscription) {
              await prisma.subscriptionOrder.create({
                data: {
                  subscriptionId: subscription.id,
                  gatewayOrderId: result.invoiceId,
                  amount: result.amount,
                  status: result.status,
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
          const result = await stripeWebhookService.handleInvoicePaymentFailed(
            event.data.object as any
          );

          const subscription = await prisma.subscription.findFirst({
            where: { externalId: result.subscriptionId as string },
          });

          if (subscription) {
            await prisma.subscriptionOrder.create({
              data: {
                subscriptionId: subscription.id,
                gatewayOrderId: result.invoiceId,
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
          break;
        }

        case "customer.subscription.deleted": {
          const result = await stripeWebhookService.handleSubscriptionDeleted(
            event.data.object as any
          );

          const subscription = await prisma.subscription.findFirst({
            where: { externalId: result.subscriptionId as string },
          });

          if (subscription) {
            await prisma.subscription.update({
              where: { id: subscription.id },
              data: { status: "canceled" },
            });
          }
          break;
        }

        default:
          console.log(`[Stripe Webhook] Evento não processado: ${event.type}`);
      }

      return res.status(200).send("OK");
    } catch (error) {
      console.error("[WebhookController.stripe]", error);
      return res.status(400).json({
        error: "Erro ao processar webhook",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private async handleSubscriptionContractCreate(payload: any) {
    console.log("[Webhook] Novo contrato de assinatura:", payload);
  }

  private async handleSubscriptionContractUpdate(payload: any) {
    console.log("[Webhook] Contrato atualizado:", payload);
  }

  private async handleOrderCreate(payload: any, shopId: string) {
    console.log("[Webhook] Nova ordem:", payload);
  }
}