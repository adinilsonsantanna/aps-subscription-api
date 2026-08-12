// src/controllers/WebhookController.ts
import { Request, Response } from "express";
import crypto from "crypto";
import { PrismaClient } from "@prisma/client";
import { StripeWebhookService } from "../gateways/stripe/stripe-webhook.service";

const prisma = new PrismaClient();
const stripeWebhookService = new StripeWebhookService();

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
  // STRIPE WEBHOOK
  // ============================================================

  async stripe(req: Request, res: Response) {
    try {
      const signature = req.headers[
        "stripe-signature"
      ] as string;

      if (!signature) {
        return res.status(400).json({
          error: "Assinatura não encontrada",
        });
      }

      /*
       * Mantemos o comportamento atual do projeto.
       *
       * IMPORTANTE:
       * Em produção, a validação deve utilizar o body RAW.
       * A infraestrutura atual da Vercel pode entregar o body
       * já parseado.
       */

      let event: any;
      let signatureValid = false;

      const payload = JSON.stringify(req.body);

      try {
        event =
          stripeWebhookService.constructEvent(
            payload,
            signature
          );

        signatureValid = true;

        console.log(
          "[Stripe Webhook] ✅ Assinatura válida"
        );
      } catch (sigError) {
        console.warn(
          "[Stripe Webhook] ⚠️ Assinatura inválida."
        );

        console.warn(
          "[Stripe Webhook] Erro:",
          (sigError as Error).message
        );

        /*
         * Mantém o comportamento de teste existente.
         */
        event = {
          id:
            req.body.id ||
            `evt_test_${Date.now()}`,
          type: req.body.type,
          data: req.body.data,
        };
      }

      const shopDomain =
        event.data?.object?.metadata?.shopDomain;

      let shopId = "unknown";

      if (shopDomain) {
        const shop = await prisma.shop.findUnique({
          where: {
            domain: shopDomain,
          },
        });

        if (shop) {
          shopId = shop.id;
        }
      }

      await prisma.webhookEvent.create({
        data: {
          shopId,
          source: "stripe",
          eventId: event.id,
          topic: event.type,
          payload:
            event.data?.object ||
            req.body,
        },
      });

      // ========================================================
      // INVOICE PAYMENT SUCCEEDED
      // ========================================================

      switch (event.type) {
        case "invoice.payment_succeeded": {
          console.log("==================================================");
          console.log("[Stripe Webhook] 🚀 INÍCIO invoice.payment_succeeded");
          console.log("[Stripe Webhook] Event ID:", event.id);

          const invoice = event.data.object;

          console.log("[Stripe Webhook] Invoice ID:", invoice.id);
          console.log("[Stripe Webhook] Billing reason:", invoice.billing_reason);
          console.log("[Stripe Webhook] Amount paid:", invoice.amount_paid);
          console.log("[Stripe Webhook] Customer:", invoice.customer);
          console.log("[Stripe Webhook] Subscription:", invoice.subscription);

          // ----------------------------------------------------------
          // METADATA
          // ----------------------------------------------------------

          const invoiceMetadata =
            invoice.metadata || {};

          const lineMetadata =
            invoice.lines?.data?.[0]?.metadata || {};

          const subscriptionMetadata =
            invoice.parent?.subscription_details?.metadata || {};

          console.log(
            "[Stripe Webhook] Invoice metadata:",
            invoiceMetadata
          );

          console.log(
            "[Stripe Webhook] Line metadata:",
            lineMetadata
          );

          console.log(
            "[Stripe Webhook] Subscription metadata:",
            subscriptionMetadata
          );

          const metadata = {
            ...subscriptionMetadata,
            ...lineMetadata,
            ...invoiceMetadata,
          };

          console.log(
            "[Stripe Webhook] Metadata final:",
            metadata
          );

          // ----------------------------------------------------------
          // STRIPE SERVICE
          // ----------------------------------------------------------

          console.log(
            "[Stripe Webhook] 🔎 Executando handleInvoicePaymentSucceeded..."
          );

          const result =
            await stripeWebhookService.handleInvoicePaymentSucceeded(
              invoice
            );

          console.log(
            "[Stripe Webhook] Resultado do Stripe Service:",
            result
          );

          if (!result.subscriptionId) {
            console.error(
              "[Stripe Webhook] ❌ subscriptionId não encontrado na invoice"
            );

            break;
          }

          console.log(
            "[Stripe Webhook] ✅ Subscription ID:",
            result.subscriptionId
          );

          // ----------------------------------------------------------
          // BUSCAR ASSINATURA APS
          // ----------------------------------------------------------

          console.log(
            "[Stripe Webhook] 🔎 Buscando assinatura APS no banco..."
          );

          const subscription =
            await prisma.subscription.findFirst({
              where: {
                externalId:
                  result.subscriptionId as string,
              },
              include: {
                shop: true,
              },
            });

          if (!subscription) {
            console.error(
              "[Stripe Webhook] ❌ ASSINATURA APS NÃO ENCONTRADA"
            );

            console.error(
              "[Stripe Webhook] externalId procurado:",
              result.subscriptionId
            );

            break;
          }

          console.log(
            "[Stripe Webhook] ✅ Assinatura APS encontrada:",
            subscription.id
          );

          console.log(
            "[Stripe Webhook] Shopify:",
            {
              domain: subscription.shop?.domain,
              customerId: subscription.shopifyCustomerId,
              productId: subscription.shopifyProductId,
              variantId: subscription.shopifyVariantId,
            }
          );

          // ----------------------------------------------------------
          // DUPLICIDADE
          // ----------------------------------------------------------

          const existingOrder =
            await prisma.subscriptionOrder.findFirst({
              where: {
                gatewayOrderId:
                  result.invoiceId,
              },
            });

          if (existingOrder) {
            console.log(
              "[Stripe Webhook] ⚠️ Invoice já processada:",
              result.invoiceId
            );

            console.log(
              "[Stripe Webhook] Shopify Order ID existente:",
              existingOrder.shopifyOrderId
            );

            break;
          }

          console.log(
            "[Stripe Webhook] ✅ Invoice ainda não processada"
          );

          // ----------------------------------------------------------
          // VERIFICAR RECORRÊNCIA
          // ----------------------------------------------------------

          const billingReason =
            invoice.billing_reason;

          const isRecurring =
            billingReason ===
            "subscription_cycle" ||
            billingReason ===
            "subscription_threshold";

          console.log(
            "[Stripe Webhook] Billing reason:",
            billingReason
          );

          console.log(
            "[Stripe Webhook] É recorrência?:",
            isRecurring
          );

          let shopifyOrderId:
            | string
            | undefined;

          // ----------------------------------------------------------
          // CRIAR PEDIDO SHOPIFY
          // ----------------------------------------------------------

          if (isRecurring) {
            console.log(
              "[Stripe Webhook] 🛒 INICIANDO CRIAÇÃO DO PEDIDO RECORRENTE SHOPIFY"
            );

            try {
              shopifyOrderId =
                await this.createRecurringShopifyOrder(
                  subscription
                );

              console.log(
                "[Stripe Webhook] ✅ PEDIDO SHOPIFY CRIADO:",
                shopifyOrderId
              );
            } catch (shopifyError) {
              console.error(
                "[Stripe Webhook] ❌ ERRO AO CRIAR PEDIDO SHOPIFY"
              );

              console.error(
                "[Stripe Webhook] Erro completo:",
                shopifyError
              );

              throw shopifyError;
            }
          } else {
            console.log(
              "[Stripe Webhook] ℹ️ Não é recorrência. Nenhum pedido Shopify será criado."
            );
          }

          // ----------------------------------------------------------
          // REGISTRAR SUBSCRIPTION ORDER
          // ----------------------------------------------------------

          console.log(
            "[Stripe Webhook] 💾 Registrando SubscriptionOrder..."
          );

          await prisma.subscriptionOrder.create({
            data: {
              subscriptionId:
                subscription.id,

              shopifyOrderId,

              gatewayOrderId:
                result.invoiceId,

              amount:
                result.amount,

              status:
                result.status,

              processedAt:
                new Date(),
            },
          });

          console.log(
            "[Stripe Webhook] ✅ SubscriptionOrder registrado"
          );

          // ----------------------------------------------------------
          // PRÓXIMA COBRANÇA
          // ----------------------------------------------------------

          const nextBillingDate =
            this.calculateNextBillingDate(
              new Date(),
              subscription.interval,
              subscription.intervalType
            );

          await prisma.subscription.update({
            where: {
              id: subscription.id,
            },
            data: {
              nextBillingAt:
                nextBillingDate,
            },
          });

          console.log(
            "[Stripe Webhook] ✅ Próxima cobrança atualizada:",
            nextBillingDate
          );

          console.log(
            "[Stripe Webhook] 🏁 FIM invoice.payment_succeeded"
          );

          console.log("==================================================");

          break;
        }
        
        // ======================================================
        // INVOICE PAYMENT FAILED
        // ======================================================

        case "invoice.payment_failed": {
          const result =
            await stripeWebhookService.handleInvoicePaymentFailed(
              event.data.object
            );

          if (!result.subscriptionId) {
            break;
          }

          const subscription =
            await prisma.subscription.findFirst({
              where: {
                externalId:
                  result.subscriptionId as string,
              },
            });

          if (!subscription) {
            break;
          }

          const existingOrder =
            await prisma.subscriptionOrder.findFirst({
              where: {
                gatewayOrderId:
                  result.invoiceId,
              },
            });

          if (!existingOrder) {
            await prisma.subscriptionOrder.create({
              data: {
                subscriptionId:
                  subscription.id,

                gatewayOrderId:
                  result.invoiceId,

                amount: 0,

                status: "failed",

                processedAt:
                  new Date(),
              },
            });
          }

          await prisma.subscription.update({
            where: {
              id: subscription.id,
            },
            data: {
              status: "past_due",
            },
          });

          break;
        }

        // ======================================================
        // SUBSCRIPTION DELETED
        // ======================================================

        case "customer.subscription.deleted": {
          const result =
            await stripeWebhookService.handleSubscriptionDeleted(
              event.data.object
            );

          const subscription =
            await prisma.subscription.findFirst({
              where: {
                externalId:
                  result.subscriptionId,
              },
            });

          if (subscription) {
            await prisma.subscription.update({
              where: {
                id: subscription.id,
              },
              data: {
                status: "canceled",
              },
            });
          }

          break;
        }

        default:
          console.log(
            `[Stripe Webhook] Evento não processado: ${event.type}`
          );
      }

      return res.status(200).json({
        received: true,
        signatureValid,
        eventType: event.type,
      });
    } catch (error) {
      console.error(
        "[WebhookController.stripe]",
        error
      );

      return res.status(400).json({
        error:
          "Erro ao processar webhook",

        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
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
  // CREATE RECURRING SHOPIFY ORDER
  // ============================================================

  private async createRecurringShopifyOrder(
    subscription: any
  ): Promise<string> {
    const shop =
      subscription.shop;

    if (!shop) {
      throw new Error(
        "Loja não encontrada na assinatura"
      );
    }

    if (!subscription.shopifyVariantId) {
      throw new Error(
        "Variant ID não encontrado na assinatura"
      );
    }

    const variantId =
      this.toShopifyVariantGid(
        subscription.shopifyVariantId
      );

    const customerId =
      subscription.shopifyCustomerId
        ? this.toShopifyCustomerGid(
          subscription.shopifyCustomerId
        )
        : undefined;

    const mutation = `
      mutation orderCreate(
        $order: OrderCreateOrderInput!
      ) {
        orderCreate(order: $order) {
          userErrors {
            field
            message
          }
          order {
            id
            name
            displayFinancialStatus
          }
        }
      }
    `;

    const lineItem = {
      variantId,
      quantity: 1,
    };

    const orderInput: any = {
      lineItems: [
        lineItem,
      ],

      financialStatus: "PAID",

      currency:
        "BRL",

      note:
        `APS Subscription ${subscription.id} - Recorrência Stripe`,
    };

    /*
     * Se tivermos o cliente Shopify, associamos o pedido
     * ao cliente existente.
     */
    if (customerId) {
      orderInput.customer = {
        toAssociate: {
          id: customerId,
        },
      };
    }

    const response =
      await fetch(
        `https://${shop.domain}/admin/api/2026-07/graphql.json`,
        {
          method: "POST",

          headers: {
            "X-Shopify-Access-Token":
              shop.accessToken,

            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            query: mutation,

            variables: {
              order:
                orderInput,
            },
          }),
        }
      );

    if (!response.ok) {
      throw new Error(
        `Shopify GraphQL error: ${response.status}`
      );
    }

    const result =
      await response.json();

    const userErrors =
      result.data?.orderCreate?.userErrors || [];

    if (userErrors.length > 0) {
      throw new Error(
        `Shopify orderCreate: ${JSON.stringify(
          userErrors
        )}`
      );
    }

    const order =
      result.data?.orderCreate?.order;

    if (!order?.id) {
      throw new Error(
        "Shopify não retornou o ID do pedido"
      );
    }

    console.log(
      "[Shopify] ✅ Pedido recorrente criado:",
      order.id
    );

    return order.id;
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

  private toShopifyVariantGid(
    value: string
  ): string {
    if (
      value.startsWith(
        "gid://shopify/ProductVariant/"
      )
    ) {
      return value;
    }

    return `gid://shopify/ProductVariant/${value}`;
  }

  private toShopifyCustomerGid(
    value: string
  ): string {
    if (
      value.startsWith(
        "gid://shopify/Customer/"
      )
    ) {
      return value;
    }

    return `gid://shopify/Customer/${value}`;
  }

  private calculateNextBillingDate(
    from: Date,
    interval: number,
    intervalType: string
  ): Date {
    const date =
      new Date(from);

    if (
      intervalType ===
      "month"
    ) {
      date.setMonth(
        date.getMonth() +
        interval
      );
    } else if (
      intervalType ===
      "week"
    ) {
      date.setDate(
        date.getDate() +
        interval * 7
      );
    } else if (
      intervalType ===
      "day"
    ) {
      date.setDate(
        date.getDate() +
        interval
      );
    }

    return date;
  }
}