import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export class ShopRepository {
    async findByDomain(domain: string) {
        return prisma.shop.findUnique({
            where: {
                domain,
            },
        });
    }

    async create(data: {
        name: string;
        domain: string;
        shopifyShopId?: string;
        accessToken: string;
        scopes: string;
    }) {
        return prisma.shop.create({
            data,
        });
    }

    async updateToken(
        domain: string,
        accessToken: string,
        scopes: string
    ) {
        return prisma.shop.update({
            where: {
                domain,
            },
            data: {
                accessToken,
                scopes,
            },
        });
    }
}