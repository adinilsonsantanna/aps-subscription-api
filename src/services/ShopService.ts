import { ShopRepository } from "../repositories/ShopRepository";

export class ShopService {
    private repository = new ShopRepository();

    async installShop(data: {
        shopifyShopId?: string;
        name: string;
        domain: string;
        accessToken: string;
        scopes: string;
    }) {
        const shop = await this.repository.findByDomain(data.domain);

        if (!shop) {
            return this.repository.create(data);
        }

        return this.repository.updateToken(
            data.domain,
            data.accessToken,
            data.scopes
        );
    }

    async findShop(domain: string) {
        return this.repository.findByDomain(domain);
    }
}