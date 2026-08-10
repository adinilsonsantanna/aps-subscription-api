import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { GatewayFactory } from "../gateways/gateway.factory";
import { ShopifyAdminService } from "../shopify/services/ShopifyAdminService";

const prisma = new PrismaClient();
const shopifyAdminService = new ShopifyAdminService();

export class SubscriptionController {
    async listByShop(req: Request, res: Response) {
        try {
            const { domain } = req.params;
            const shop = await prisma.shop.findUnique({
                where: { domain },
                include: { subscriptions: true },
            });

            if (!shop) {
                return res.status(404).json({ error: "Loja não encontrada" });
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
                return res.status(404).json({ error: "Loja não encontrada" });
            }

            const selectedGateway = gateway || shop.gateway || "stripe";

            const nextBillingDate = new Date();
            nextBillingDate.setMonth(nextBillingDate.getMonth() + (intervalType === "month" ? interval : 0));

            const shopifyContract = await shopifyAdminService.createSubscriptionContract(
                shop.domain,
                shop.accessToken,
                {
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
                }
            );

            if (shopifyContract.data?.subscriptionContractCreate?.userErrors?.length > 0) {
                return res.status(400).json({
                    error: "Erro ao criar contrato no Shopify",
                    details: shopifyContract.data.subscriptionContractCreate.userErrors,
                });
            }

            const shopifyContractId = shopifyContract.data?.subscriptionContractCreate?.contract?.id;

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
            const { id } = req.params;
            const subscription = await prisma.subscription.findUnique({
                where: { id },
                include: { shop: true, orders: true },
            });

            if (!subscription) {
                return res.status(404).json({ error: "Assinatura não encontrada" });
            }

            return res.status(200).json(subscription);
        } catch (error) {
            console.error("[SubscriptionController.getById]", error);
            return res.status(500).json({ error: "Erro interno" });
        }
    }

    async updateStatus(req: Request, res: Response) {
        try {
            const { id } = req.params;
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
            const { id } = req.params;
            const subscription = await prisma.subscription.findUnique({
                where: { id },
                include: { shop: true },
            });

            if (!subscription) {
                return res.status(404).json({ error: "Assinatura não encontrada" });
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