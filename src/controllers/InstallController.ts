import { Request, Response } from "express";
import { ShopService } from "../services/ShopService";
import { ShopifyAdminService } from "../shopify/services/ShopifyAdminService";

export class InstallController {
  private shopService = new ShopService();
  private shopifyAdminService = new ShopifyAdminService();

  async install(req: Request, res: Response) {
    try {
      const {
        shopifyShopId,
        name,
        domain,
        accessToken,
        scopes,
      } = req.body;

      const shop = await this.shopService.installShop({
        shopifyShopId,
        name,
        domain,
        accessToken,
        scopes,
      });

      return res.status(200).json(shop);
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        error: "Erro ao salvar loja",
      });
    }
  }

  async test(req: Request, res: Response) {
    try {
      const { domain } = req.params;

      const result = await this.shopifyAdminService.testConnection(domain);

      return res.status(200).json(result);
    } catch (error: any) {
      console.error(error);

      return res.status(500).json({
        error: error.message,
      });
    }
  }
}