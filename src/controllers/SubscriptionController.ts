import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { GatewayFactory } from "../gateways/gateway.factory";
import { LifecycleActionName, LifecycleError, SubscriptionLifecycleService } from "../services/SubscriptionLifecycleService";


const prisma = new PrismaClient();


export class SubscriptionController {
    constructor(private lifecycle = new SubscriptionLifecycleService()) {}

    async lifecycleAction(req: Request, res: Response) {
        try {
            const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const action = req.path.split("/").filter(Boolean).at(-1) as LifecycleActionName;
            const key = req.header("Idempotency-Key") || "";
            const actor = typeof req.body?.actor === "string" ? req.body.actor.toUpperCase() : "CUSTOMER";
            const result = await this.lifecycle.execute(id, action as LifecycleActionName, key, actor);
            return res.status(200).json(result);
        } catch (error) {
            if (error instanceof LifecycleError) return res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
            console.error("[SubscriptionController.lifecycleAction]", error instanceof Error ? error.message : "Unknown error");
            return res.status(500).json({ error: { code: "internal_error", message: "Internal error" } });
        }
    }

    async cancelCompatibility(req: Request, res: Response) {
        try {
            const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const key = req.header("Idempotency-Key") || `legacy-delete:${id}`;
            const actor = typeof req.body?.actor === "string" ? req.body.actor.toUpperCase() : "CUSTOMER";
            return res.status(200).json(await this.lifecycle.execute(id, "cancel", key, actor));
        } catch (error) {
            if (error instanceof LifecycleError) return res.status(error.statusCode).json({ error: { code: error.code, message: error.message } });
            return res.status(500).json({ error: { code: "internal_error", message: "Internal error" } });
        }
    }
    async listByShop(req: Request, res: Response) {
        try {
            const domain = Array.isArray(req.params.domain) ? req.params.domain[0] : req.params.domain;

            const shop = await prisma.shop.findUnique({
                where: { domain },
                include: { subscriptions: true },
            });

            if (!shop) {
                return res.status(404).json({ error: "Loja nao encontrada" });
            }

            return res.status(200).json(shop.subscriptions);
        } catch (error) {
            console.error("[SubscriptionController.listByShop]", error);
            return res.status(500).json({ error: "Erro interno" });
        }
    }

    async create(req: Request, res: Response) {
        // Deprecated: Shopify Checkout now creates subscription contracts natively.
        if (process.env.ENABLE_LEGACY_SUBSCRIPTION_FLOW !== "true") {
            return res.status(410).json({ error: "Legacy subscription flow is disabled" });
        }

        try {
            const {
                domain,
                shopifyCustomerId,
                shopifyProductId,
                shopifyVariantId,
                interval,
                intervalType,
                gateway,
                customerEmail,
                customerName,
                paymentMethodId,
                priceAmount,
                currency,
            } = req.body;

            const shop = await prisma.shop.findUnique({ where: { domain } });

            if (!shop) {
                return res.status(404).json({ error: "Loja nao encontrada" });
            }

            const selectedGateway = gateway || shop.gateway || "stripe";

            const nextBillingDate = new Date();
            nextBillingDate.setMonth(nextBillingDate.getMonth() + (intervalType === "month" ? interval : 0));

            const appUrl = process.env.SHOPIFY_APP_URL || "";
            const appApiKey = process.env.SHOPIFY_APP_API_KEY || "";

            if (!appUrl || !appApiKey) {
                throw new Error(
                    "SHOPIFY_APP_URL ou SHOPIFY_APP_API_KEY não configurado"
                );
            }

            const shopifyInput = {
                customerId: shopifyCustomerId,
                nextBillingDate: nextBillingDate.toISOString(),
                currencyCode: currency || "BRL",
                billingPolicy: {
                    interval: intervalType,
                    intervalCount: interval,
                },
                deliveryPolicy: {
                    interval: intervalType,
                    intervalCount: interval,
                },
                lines: [
                    {
                        productVariantId: shopifyVariantId,
                        quantity: 1,
                        currentPrice: String(priceAmount / 100),
                    },
                ],
            };

            const shopifyResponse = await fetch(
                `${appUrl}/api/shopify/create-subscription-contract`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": appApiKey,
                    },
                    body: JSON.stringify({
                        shop: shop.domain,
                        input: shopifyInput,
                    }),
                }
            );

            const shopifyContract = await shopifyResponse.json();

            if (!shopifyResponse.ok) {
                console.error(
                    "[SubscriptionController] Erro no App Shopify:",
                    shopifyResponse.status,
                    shopifyContract
                );

                return res.status(502).json({
                    error: "Erro ao criar contrato no Shopify",
                    details: shopifyContract,
                });
            }

            if (!shopifyContract.success) {
                return res.status(400).json({
                    error: "Erro ao criar contrato no Shopify",
                    details: shopifyContract,
                });
            }

            const shopifyContractId =
                shopifyContract.contract?.id;

            if (!shopifyContractId) {
                return res.status(502).json({
                    error: "Shopify não retornou o ID do contrato",
                    details: shopifyContract,
                });
            }

            if (shopifyContract.data?.subscriptionContractCreate?.userErrors?.length > 0) {
                return res.status(400).json({
                    error: "Erro ao criar contrato no Shopify",
                    details: shopifyContract.data.subscriptionContractCreate.userErrors,
                });
            }



            const gatewayInstance = GatewayFactory.create(selectedGateway);

            const gatewayResult = await gatewayInstance.createSubscription({
                customerEmail,
                customerName,
                priceAmount,
                currency: currency || "BRL",
                interval,
                intervalType,
                paymentMethodId,
                metadata: {
                    shopifyContractId,
                    shopifyCustomerId,
                    shopifyProductId,
                    shopDomain: domain,
                    productName: customerName || "Assinatura",
                },
            });

            const subscription = await prisma.subscription.create({
                data: {
                    shopId: shop.id,
                    shopifyCustomerId,
                    shopifyProductId,
                    shopifyVariantId,
                    interval,
                    intervalType,
                    gateway: selectedGateway,
                    externalId: gatewayResult.externalId,
                    stripeCustomerId: gatewayResult.customerId,
                    stripePaymentMethodId: gatewayResult.paymentMethodId,
                    status: gatewayResult.status === "active" ? "active" : "pending",
                    nextBillingAt: gatewayResult.currentPeriodEnd,
                },
            });

            return res.status(201).json({
                subscription,
                shopifyContractId,
                gatewaySubscriptionId: gatewayResult.externalId,
            });
        } catch (error) {
            console.error("[SubscriptionController.create]", error);
            return res.status(500).json({
                error: "Erro ao criar assinatura",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

            const subscription = await prisma.subscription.findUnique({
                where: { id },
                include: { shop: true, orders: true },
            });

            if (!subscription) {
                return res.status(404).json({ error: "Assinatura nao encontrada" });
            }

            return res.status(200).json(subscription);
        } catch (error) {
            console.error("[SubscriptionController.getById]", error);
            return res.status(500).json({ error: "Erro interno" });
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const { status } = req.body;
            const subscription = await prisma.subscription.update({
                where: { id },
                data: { status },
            });
            return res.status(200).json(subscription);
        } catch (error) {
            console.error("[SubscriptionController.updateStatus]", error);
            return res.status(500).json({ error: "Erro ao atualizar assinatura" });
        }
    }

}
