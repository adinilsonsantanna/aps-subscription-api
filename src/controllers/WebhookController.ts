// src/controllers/WebhookController.ts
import { Request, Response } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class WebhookController {
  // ============================================================
  // SHOPIFY WEBHOOK
  // ============================================================

  async shopify(req: Request, res: Response) {
    try {
      const topic = req.headers["x-shopify-topic"] as string;
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const shop = req.headers["x-shopify-shop-domain"] as string;
      const webhookId = req.headers["x-shopify-webhook-id"] as string;

      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(req.body);

      const body = rawBody.toString("utf8");

      const hash = crypto
        .createHmac(
          "sha256",
          process.env.SHOPIFY_WEBHOOK_SECRET || ""
        )
        .update(body, "utf8")
        .digest("base64");

      if (hash !== hmac) {
        console.error("[Shopify Webhook] HMAC inválido");
        return res.status(401).json({
          error: "Assinatura inválida",
        });
      }

      const payload = JSON.parse(body);

      const shopRecord = await prisma.shop.findUnique({
        where: {
          domain: shop,
        },
      });

      if (!shopRecord) {
        return res.status(404).json({
          error: "Loja não encontrada",
        });
      }

      // Evita processar o mesmo webhook duas vezes.
      if (webhookId) {
        const existingEvent = await prisma.webhookEvent.findFirst({
          where: {
            eventId: webhookId,
          },
        });

        if (existingEvent) {
          console.log(
            `[Shopify Webhook] Evento ${webhookId} já processado`
          );

          return res.status(200).send("OK");
        }
      }

      await prisma.webhookEvent.create({
        data: {
          shopId: shopRecord.id,
          source: "shopify",
          eventId: webhookId,
          topic,
          payload,
        },
      });

      switch (topic) {
        case "subscription_contracts/create":
          await this.handleSubscriptionContractCreate(payload);
          break;

        case "subscription_contracts/update":
          await this.handleSubscriptionContractUpdate(payload);
          break;

        case "orders/create":
          await this.handleOrderCreate(
            payload,
            shopRecord.id
          );
          break;

        case "orders/paid":
          await this.handleOrderPaid(
            payload,
            shopRecord.id
          );
          break;

        default:
          console.log(
            `[Shopify Webhook] Tópico não processado: ${topic}`
          );
      }

      return res.status(200).send("OK");
    } catch (error) {
      console.error(
        "[WebhookController.shopify]",
        error
      );

      return res.status(500).json({
        error: "Erro interno",
      });
    }
  }

  // ============================================================
  // SHOPIFY SUBSCRIPTION CONTRACT
  // ============================================================

  private async handleSubscriptionContractCreate(
    payload: any
  ) {
    console.log(
      "[Shopify Webhook] Novo contrato:",
      payload
    );
  }

  private async handleSubscriptionContractUpdate(
    payload: any
  ) {
    console.log(
      "[Shopify Webhook] Contrato atualizado:",
      payload
    );
  }

  // ============================================================
  // SHOPIFY ORDER CREATE
  // ============================================================

  private async handleOrderCreate(
    payload: any,
    shopId: string
  ) {
    try {
      const order = payload;

      const isSubscription =
        this.isSubscriptionOrder(order);

      if (!isSubscription) {
        console.log(
          "[Shopify Webhook] Pedido normal. Ignorando:",
          order.id
        );

        return;
      }

      console.log(
        "[Shopify Webhook] Pedido de assinatura:",
        order.id
      );

      const shopifyOrderId =
        String(order.id);

      /*
       * Procura a assinatura pelo produto/variante
       * armazenado nas propriedades APS do pedido.
       */
      const apsData =
        this.extractSubscriptionData(order);

      if (!apsData) {
        console.warn(
          "[Shopify Webhook] Pedido possui assinatura, mas não foram encontradas propriedades APS:",
          shopifyOrderId
        );
        return;
      }

      const subscription =
        await prisma.subscription.findFirst({
          where: {
            shopId,
            shopifyProductId:
              apsData.productId,
            shopifyVariantId:
              apsData.variantId,
            status: {
              in: [
                "pending",
                "active",
              ],
            },
          },
        });

      if (!subscription) {
        console.warn(
          "[Shopify Webhook] Assinatura não encontrada para pedido:",
          shopifyOrderId
        );

        return;
      }

      /*
       * Evita duplicidade.
       */
      const existingOrder =
        await prisma.subscriptionOrder.findFirst({
          where: {
            shopifyOrderId,
          },
        });

      if (existingOrder) {
        console.log(
          "[Shopify Webhook] Pedido já vinculado:",
          shopifyOrderId
        );

        return;
      }

      /*
       * Registra o primeiro pedido.
       *
       * A cobrança inicial foi feita pelo Shopify Checkout.
       * Não criamos Stripe aqui.
       */
      await prisma.subscriptionOrder.create({
        data: {
          subscriptionId:
            subscription.id,

          shopifyOrderId,

          amount:
            Number(order.total_price || 0),

          status: "paid",

          processedAt:
            new Date(),
        },
      });

      console.log(
        "[Shopify Webhook] ✅ Pedido inicial vinculado:",
        shopifyOrderId
      );
    } catch (error) {
      console.error(
        "[Webhook] Erro ao processar orders/create:",
        error
      );

      throw error;
    }
  }

  // ============================================================
  // SHOPIFY ORDER PAID
  // ============================================================

  private async handleOrderPaid(
    payload: any,
    shopId: string
  ) {
    const order = payload;

    if (!this.isSubscriptionOrder(order)) {
      return;
    }

    console.log(
      "[Shopify Webhook] Assinatura paga:",
      order.id
    );

    /*
     * O processamento principal do pedido inicial é feito
     * pelo orders/create.
     *
     * Aqui apenas registramos o evento.
     */
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private isSubscriptionOrder(
    order: any
  ): boolean {
    const lineItems =
      order?.line_items || [];

    return lineItems.some(
      (item: any) => {
        const properties =
          item.properties || [];

        return properties.some(
          (property: any) =>
            property.name ===
            "_aps_subscription" &&
            String(
              property.value
            ).toLowerCase() ===
            "true"
        );
      }
    );
  }

  private extractSubscriptionData(
    order: any
  ) {
    const lineItems =
      order?.line_items || [];

    for (const item of lineItems) {
      const properties =
        item.properties || [];

      const getProperty = (
        name: string
      ) => {
        const property =
          properties.find(
            (p: any) =>
              p.name === name
          );

        return property?.value;
      };

      const subscription =
        getProperty(
          "_aps_subscription"
        );

      if (
        String(subscription)
          .toLowerCase() !==
        "true"
      ) {
        continue;
      }

      return {
        productId:
          getProperty(
            "_aps_product_id"
          ) ||
          String(
            item.product_id || ""
          ),

        variantId:
          getProperty(
            "_aps_variant_id"
          ) ||
          String(
            item.variant_id || ""
          ),

        planId:
          getProperty(
            "_aps_plan_id"
          ),

        plan:
          getProperty(
            "_aps_plan"
          ),

        interval:
          getProperty(
            "_aps_interval"
          ),

        intervalType:
          getProperty(
            "_aps_interval_type"
          ),
      };
    }

    return null;
  }

}
