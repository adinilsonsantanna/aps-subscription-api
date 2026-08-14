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

      // ============================================================
      // CONTROLE DE DUPLICIDADE DO WEBHOOK STRIPE
      // ============================================================

      const eventId = event.id;

      let existingWebhookEvent =
        await prisma.webhookEvent.findFirst({
          where: {
            eventId,
          },
        });

      if (existingWebhookEvent) {
        console.log(
          `[Stripe Webhook] Evento ${eventId} já existe.`
        );

        console.log(
          "[Stripe Webhook] Processado:",
          existingWebhookEvent.processed
        );

        if (existingWebhookEvent.processed) {
          console.log(
            "[Stripe Webhook] ✅ Evento já processado. Ignorando."
          );

          return res.status(200).json({
            received: true,
            alreadyProcessed: true,
            eventType: event.type,
          });
        }

        console.log(
          "[Stripe Webhook] ⚠️ Evento existe mas NÃO foi processado."
        );

        console.log(
          "[Stripe Webhook] 🔄 Continuando processamento..."
        );
      } else {
        // ============================================================
        // IDENTIFICAÇÃO DA LOJA PARA WEBHOOK STRIPE
        // ============================================================

        const stripeObject = event.data?.object;

        // O shopDomain pode estar em diferentes níveis da Invoice Stripe.
        // Priorizamos os metadados da própria invoice e depois os
        // metadados da assinatura/linha da invoice.
        const shopDomain =
          stripeObject?.metadata?.shopDomain ||
          stripeObject?.parent?.subscription_details?.metadata?.shopDomain ||
          stripeObject?.subscription_details?.metadata?.shopDomain ||
          stripeObject?.lines?.data?.[0]?.metadata?.shopDomain ||
          null;

        console.log(
          "[Stripe Webhook] Shop Domain identificado:",
          shopDomain
        );

        let shopId: string | null = null;

        if (shopDomain) {
          const shop = await prisma.shop.findUnique({
            where: {
              domain: shopDomain,
            },
          });

          if (shop) {
            shopId = shop.id;

            console.log(
              "[Stripe Webhook] ✅ Loja encontrada:",
              shop.domain,
              "| ID:",
              shop.id
            );
          } else {
            console.error(
              "[Stripe Webhook] ❌ Loja não encontrada para domínio:",
              shopDomain
            );
          }
        }

        if (!shopId) {
          console.error(
            "[Stripe Webhook] ❌ Não foi possível identificar a loja."
          );

          return res.status(400).json({
            error: "Loja não identificada no webhook Stripe",
            eventId,
            shopDomain,
          });
        }

        existingWebhookEvent =
          await prisma.webhookEvent.create({
            data: {
              shopId,
              source: "stripe",
              eventId,
              topic: event.type,
              payload:
                event.data?.object ||
                req.body,
              processed: false,
            },
          });

        console.log(
          `[Stripe Webhook] ✅ Evento ${eventId} registrado como não processado.`
        );
      }

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
                  subscription,
                  invoice
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

          if (
            subscription.interval !== null &&
            subscription.intervalType !== null
          ) {
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
          }

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

      // ============================================================
      // MARCAR WEBHOOK COMO PROCESSADO
      // ============================================================

      if (event.id) {
        await prisma.webhookEvent.updateMany({
          where: {
            eventId: event.id,
          },
          data: {
            processed: true,
          },
        });

        console.log(
          `[Stripe Webhook] ✅ Evento ${event.id} marcado como processado.`
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
    subscription: any,
    invoice: any
  ): Promise<string> {
    const shop = subscription.shop;

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



    // ============================================================
    // DADOS DA INVOICE STRIPE
    // ============================================================

    const amountPaid =
      Number(invoice.amount_paid || 0) / 100;

    const currency =
      String(
        invoice.currency || "brl"
      ).toUpperCase();

    const customerEmail =
      invoice.customer_email ||
      invoice.customer_details?.email ||
      undefined;

    const customerName =
      invoice.customer_name ||
      invoice.customer_details?.name ||
      undefined;

    const customerPhone =
      invoice.customer_phone ||
      invoice.customer_details?.phone ||
      undefined;

    // ============================================================
    // SEPARAR NOME
    // ============================================================

    let firstName: string | undefined;
    let lastName: string | undefined;

    if (customerName) {
      const parts =
        String(customerName)
          .trim()
          .split(/\s+/);

      firstName = parts.shift();

      if (parts.length > 0) {
        lastName = parts.join(" ");
      }
    }

    // ============================================================
    // ENDEREÇO STRIPE
    // ============================================================

    const stripeAddress =
      invoice.customer_shipping?.address ||
      invoice.customer_details?.address ||
      undefined;

    const shippingAddress =
      stripeAddress
        ? {
          firstName,
          lastName,
          address1:
            stripeAddress.line1 || undefined,
          address2:
            stripeAddress.line2 || undefined,
          city:
            stripeAddress.city || undefined,
          province:
            stripeAddress.state || undefined,
          countryCode:
            stripeAddress.country || undefined,
          zip:
            stripeAddress.postal_code || undefined,
        }
        : undefined;

    // ============================================================
    // METADADOS
    // ============================================================

    const customAttributes = [
      {
        key: "APS Subscription ID",
        value: String(subscription.id),
      },
      {
        key: "Stripe Invoice ID",
        value: String(invoice.id),
      },
      {
        key: "Stripe Subscription ID",
        value: String(
          invoice.subscription || ""
        ),
      },
    ];

    // ============================================================
    // MUTATION SHOPIFY
    // ============================================================

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
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }

          customer {
            id
            email
            firstName
            lastName
          }
        }
      }
    }
  `;

    // ============================================================
    // LINE ITEM
    // ============================================================

    const lineItem: any = {
      variantId,
      quantity: 1,

      /*
       * IMPORTANTE:
       * Usa o valor efetivamente pago na Stripe.
       *
       * Isso evita que o Shopify utilize o preço atual
       * da variante.
       */
      priceSet: {
        shopMoney: {
          amount: amountPaid.toFixed(2),
          currencyCode: currency,
        },
      },

      properties: [
        {
          name: "_aps_subscription",
          value: "true",
        },
        {
          name: "_aps_subscription_id",
          value: String(subscription.id),
        },
        {
          name: "_stripe_invoice_id",
          value: String(invoice.id),
        },
      ],
    };

    // ============================================================
    // ORDER INPUT
    // ============================================================

    const orderInput: any = {
      lineItems: [
        lineItem,
      ],

      financialStatus: "PAID",

      currency,

      presentmentCurrency: currency,

      email: customerEmail,

      phone: customerPhone,

      customer: {
        toUpsert: {
          email: customerEmail,
          firstName,
          lastName,
          phone: customerPhone,
        },
      },

      note:
        `APS Subscription ${subscription.id} - ` +
        `Recorrência Stripe - Invoice ${invoice.id}`,

      customAttributes,

      /*
       * Mantém a data real da cobrança Stripe.
       */
      processedAt:
        invoice.status_transitions?.paid_at
          ? new Date(
            Number(
              invoice.status_transitions.paid_at
            ) * 1000
          ).toISOString()
          : new Date().toISOString(),

      /*
       * Registra a transação como paga.
       */
      transactions: [
        {
          kind: "SALE",

          status: "SUCCESS",

          amountSet: {
            shopMoney: {
              amount: amountPaid.toFixed(2),
              currencyCode: currency,
            },
          },
        },
      ],
    };

    // ============================================================
    // CLIENTE SHOPIFY
    // ============================================================



    // ============================================================
    // ENDEREÇO
    // ============================================================

    if (shippingAddress) {
      orderInput.shippingAddress =
        shippingAddress;

      orderInput.billingAddress =
        shippingAddress;
    }

    // ============================================================
    // LOG
    // ============================================================

    console.log(
      "[Shopify] Criando pedido recorrente:"
    );

    console.log({
      subscriptionId:
        subscription.id,

      stripeInvoice:
        invoice.id,

      stripeSubscription:
        invoice.subscription,



      customerEmail,

      customerName,

      amountPaid,

      currency,
    });

    // ============================================================
    // SHOPIFY APP API
    // ============================================================
    //
    // IMPORTANTE:
    // A API Central não acessa mais a Shopify diretamente.
    //
    // O App Shopify é responsável pela sessão offline,
    // incluindo a renovação dos expiring offline access tokens.
    //
    // ============================================================

    const shopifyAppUrl =
      process.env.SHOPIFY_APP_URL;

    const internalApiKey =
      process.env.API_KEY;

    if (!shopifyAppUrl) {
      throw new Error(
        "SHOPIFY_APP_URL não configurado na API Central"
      );
    }

    if (!internalApiKey) {
      throw new Error(
        "API_KEY não configurada na API Central"
      );
    }

    console.log(
      "[Shopify] Solicitando criação do pedido ao App Shopify..."
    );

    const response =
      await fetch(
        `${shopifyAppUrl}/api/shopify/create-recurring-order`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "X-API-Key":
              internalApiKey,
          },

          body: JSON.stringify({
            shop: shop.domain,

            order: orderInput,
          }),
        }
      );

    // ============================================================
    // ERRO HTTP
    // ============================================================

    if (!response.ok) {
      const errorText =
        await response.text();

      console.error(
        "[Shopify] App Shopify retornou erro:",
        response.status,
        errorText
      );

      throw new Error(
        `Shopify App API error: ${response.status} - ${errorText}`
      );
    }

    // ============================================================
    // RESPOSTA
    // ============================================================

    const result =
      await response.json();

    console.log(
      "[Shopify] Resposta do App Shopify:",
      JSON.stringify(
        result,
        null,
        2
      )
    );

    // ============================================================
    // VALIDAR PEDIDO
    // ============================================================

    if (!result?.order?.id) {
      throw new Error(
        "Shopify App não retornou o ID do pedido"
      );
    }

    const order =
      result.order;

    console.log(
      "[Shopify] ✅ Pedido recorrente criado:",
      order.id
    );

    console.log(
      "[Shopify] Nome do pedido:",
      order.name
    );

    console.log(
      "[Shopify] Cliente:",
      order.customer
    );

    console.log(
      "[Shopify] Total:",
      order.totalPriceSet
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
