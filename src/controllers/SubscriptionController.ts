import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { GatewayFactory } from "../gateways/gateway.factory";


const prisma = new PrismaClient();


export class SubscriptionController {
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

    async cancel(req: Request, res: Response) {
        try {
            const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

            const subscription = await prisma.subscription.findUnique({
                where: { id },
                include: { shop: true },
            });

            if (!subscription) {
                return res.status(404).json({ error: "Assinatura nao encontrada" });
            }

            if (subscription.externalId && subscription.gateway === "stripe") {
                const gateway = GatewayFactory.create("stripe");
                await gateway.cancelSubscription(subscription.externalId);
            }

            const updated = await prisma.subscription.update({
                where: { id },
                data: { status: "canceled" },
            });

            return res.status(200).json(updated);
        } catch (error) {
            console.error("[SubscriptionController.cancel]", error);
            return res.status(500).json({ error: "Erro ao cancelar assinatura" });
        }
    }
}