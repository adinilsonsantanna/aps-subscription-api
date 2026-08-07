// src/repositories/ShopRepository.ts
// Repositório para operações CRUD da entidade Shop no Prisma

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class ShopRepository {
    /**
     * Busca uma loja pelo domínio (ex: minhaloja.myshopify.com)
     */
    async findByDomain(domain: string) {
        return prisma.shop.findUnique({
            where: { domain },
        });
    }

    /**
     * Busca uma loja pelo ID do Shopify
     */
    async findByShopifyId(shopifyShopId: string) {
        return prisma.shop.findUnique({
            where: { shopifyShopId },
        });
    }

    /**
     * Cria uma nova loja na API Central
     */
    async create(data: {
        shopifyShopId?: string;
        name: string;
        domain: string;
        accessToken: string;
        scopes: string;
    }) {
        return prisma.shop.create({
            data: {
                shopifyShopId: data.shopifyShopId || null,
                name: data.name,
                domain: data.domain,
                accessToken: data.accessToken,
                scopes: data.scopes,
            },
        });
    }

    /**
     * Atualiza o token de acesso e scopes de uma loja existente
     */
    async updateToken(domain: string, accessToken: string, scopes: string) {
        return prisma.shop.update({
            where: { domain },
            data: {
                accessToken,
                scopes,
                updatedAt: new Date(),
            },
        });
    }

    /**
     * Lista todas as lojas cadastradas
     */
    async findAll() {
        return prisma.shop.findMany();
    }
}