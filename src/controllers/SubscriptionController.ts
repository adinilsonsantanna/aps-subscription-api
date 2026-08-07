// src/controllers/SubscriptionController.ts
// Controller para gerenciamento de assinaturas

import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class SubscriptionController {
    /**
     * Lista todas as assinaturas de uma loja
     */
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

    /**
     * Cria uma nova assinatura
     */
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
            } = req.body;

            const shop = await prisma.shop.findUnique({
                where: { domain },
            });

            if (!shop) {
                return res.status(404).json({ error: "Loja não encontrada" });
            }

            const subscription = await prisma.subscription.create({
                data: {
                    shopId: shop.id,
                    shopifyCustomerId,
                    shopifyProductId,
                    shopifyVariantId,
                    interval,
                    intervalType,
                    gateway: gateway || "mercado_pago",
                    nextBillingAt: new Date(), // Calcular corretamente baseado no intervalo
                },
            });

            return res.status(201).json(subscription);
        } catch (error) {
            console.error("[SubscriptionController.create]", error);
            return res.status(500).json({ error: "Erro ao criar assinatura" });
        }
    }

    /**
     * Busca uma assinatura pelo ID
     */
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

    /**
     * Atualiza o status de uma assinatura
     */
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
}