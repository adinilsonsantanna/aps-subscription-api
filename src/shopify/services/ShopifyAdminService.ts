import { ShopifyGraphqlClient } from "../clients/ShopifyGraphqlClient";
import { ShopRepository } from "../../repositories/ShopRepository";

export class ShopifyAdminService {
  private client = new ShopifyGraphqlClient();
  private shopRepository = new ShopRepository();

  async testConnection(domain: string) {
    const shop = await this.shopRepository.findByDomain(domain);

    if (!shop) {
      throw new Error("Loja não encontrada.");
    }

    return this.client.query(
      shop.domain,
      shop.accessToken,
      `
      query {
        shop {
          id
          name
          email
          myshopifyDomain
        }
      }
      `
    );
  }
}
