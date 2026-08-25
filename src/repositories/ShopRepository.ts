import { Prisma, PrismaClient } from "@prisma/client";

export interface DurableShopInstallation {
  shopifyShopId: string;
  name: string;
  domain: string;
  accessToken: string;
  scopes: string;
}

export class ShopIdentityConflictError extends Error {}

export class ShopRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  findByDomain(domain: string) { return this.prisma.shop.findUnique({ where: { domain } }); }
  findByShopifyId(shopifyShopId: string) { return this.prisma.shop.findUnique({ where: { shopifyShopId } }); }

  async installOrReactivate(data: DurableShopInstallation) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const [byDomain, byShopifyId] = await Promise.all([
            tx.shop.findUnique({ where: { domain: data.domain } }),
            tx.shop.findUnique({ where: { shopifyShopId: data.shopifyShopId } }),
          ]);
          if (byDomain && byDomain.shopifyShopId !== data.shopifyShopId) throw new ShopIdentityConflictError("Shop ID does not match the registered domain");
          if (byShopifyId && byShopifyId.domain !== data.domain) throw new ShopIdentityConflictError("Domain does not match the registered shop ID");
          const existing = byDomain ?? byShopifyId;
          if (!existing) return tx.shop.create({ data: { ...data, isActive: true, installationGeneration: 1, lastInstalledAt: new Date() } });
          if (existing.isActive) return tx.shop.update({ where: { id: existing.id }, data: { name: data.name, accessToken: data.accessToken, scopes: data.scopes } });

          const reactivated = await tx.shop.updateMany({
            where: { id: existing.id, domain: data.domain, shopifyShopId: data.shopifyShopId, isActive: false, installationGeneration: existing.installationGeneration },
            data: { name: data.name, accessToken: data.accessToken, scopes: data.scopes, isActive: true, lastInstalledAt: new Date(), lastUninstalledAt: null, installationGeneration: { increment: 1 } },
          });
          if (reactivated.count !== 1) throw new Prisma.PrismaClientKnownRequestError("Concurrent installation", { code: "P2034", clientVersion: Prisma.prismaVersion.client });
          return tx.shop.findUniqueOrThrow({ where: { id: existing.id } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code) && attempt < 2) continue;
        throw error;
      }
    }
    throw new Error("Installation transaction retry exhausted");
  }

  create(data: DurableShopInstallation) { return this.prisma.shop.create({ data }); }
  findAll() { return this.prisma.shop.findMany(); }
}
