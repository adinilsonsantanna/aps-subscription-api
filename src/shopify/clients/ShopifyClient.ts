export class ShopifyClient {
  private apiVersion = "2025-10";

  adminApi(shop: string) {
    return `https://${shop}/admin/api/${this.apiVersion}`;
  }

  oauth(shop: string) {
    return `https://${shop}/admin/oauth`;
  }
}