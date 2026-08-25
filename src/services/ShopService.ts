import { ShopRepository } from "../repositories/ShopRepository";

export class ShopService {
    constructor(private readonly repository = new ShopRepository()) {}

    async findByDomain(domain: string) {
        return this.repository.findByDomain(domain);
    }

    async installShop(data: {
        shopifyShopId?: string;
        name: string;
        domain: string;
        accessToken: string;
        scopes: string;
    }) {
        const domain = data.domain.trim().toLowerCase();
        const shopifyShopId = data.shopifyShopId?.trim();
        if (!/^([a-z0-9][a-z0-9-]*\.)*myshopify\.com$/.test(domain)) {
            throw new Error("dominio Shopify invalido");
        }
        if (!shopifyShopId || !/^gid:\/\/shopify\/Shop\/\d+$/.test(shopifyShopId)) {
            throw new Error("shopifyShopId é obrigatório para instalação durável");
        }
        return this.repository.installOrReactivate({
            shopifyShopId,
            name: data.name,
            domain,
            accessToken: data.accessToken,
            scopes: data.scopes,
        });
    }

    async findShop(domain: string) {
        return this.repository.findByDomain(domain);
    }
}
