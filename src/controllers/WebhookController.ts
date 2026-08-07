// src/controllers/WebhookController.ts
// Controller para processar webhooks do Shopify e Mercado Pago

import { Request, Response } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class WebhookController {
  /**
   * Processa webhooks do Shopify
   */
  async shopify(req: Request, res: Response) {
    try {
      const topic = req.headers["x-shopify-topic"] as string;
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const shop = req.headers["x-shopify-shop-domain"] as string;

      // Verifica a assinatura do webhook
      const body = JSON.stringify(req.body);
      const hash = crypto
        .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET || "")
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmac) {
        return res.status(401).json({ error: "Assinatura inválida" });
      }

      // Salva o evento no banco
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

      // Processa o webhook conforme o tópico
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
   * Processa webhooks do Mercado Pago
   */
  async mercadoPago(req: Request, res: Response) {
    try {
      const signature = req.headers["x-signature"] as string;
      const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET || "";

      // TODO: Implementar verificação de assinatura do Mercado Pago
      // https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks#validar-origem

      const { type, data } = req.body;

      if (type === "subscription_authorized_payment") {
        // Processa pagamento de assinatura
        console.log("[MP Webhook] Pagamento recebido:", data);
      }

      return res.status(200).send("OK");
    } catch (error) {
      console.error("[WebhookController.mercadoPago]", error);
      return res.status(500).json({ error: "Erro interno" });
    }
  }

  private async handleSubscriptionContractCreate(payload: any) {
    console.log("[Webhook] Novo contrato de assinatura:", payload);
    // Implementar lógica de criação
  }

  private async handleSubscriptionContractUpdate(payload: any) {
    console.log("[Webhook] Contrato atualizado:", payload);
    // Implementar lógica de atualização
  }

  private async handleOrderCreate(payload: any, shopId: string) {
    console.log("[Webhook] Nova ordem:", payload);
    // Implementar lógica de processamento de pedido
  }
}