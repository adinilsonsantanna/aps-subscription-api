// src/controllers/InstallController.ts
// Controller para instalação/sincronização de lojas

import { Request, Response } from "express";
import { ShopService } from "../services/ShopService";
import { ShopifyAdminService } from "../shopify/services/ShopifyAdminService";

export class InstallController {
  private shopService = new ShopService();
  private shopifyAdminService = new ShopifyAdminService();

  /**
   * Recebe os dados da loja do App Shopify e salva na API Central
   */
  async install(req: Request, res: Response) {
    try {
      const body = req.body as {
        shopifyShopId?: string;
        name?: string;
        domain: string;
        accessToken: string;
        scopes?: string;
      };

      const {
        shopifyShopId,
        name,
        domain,
        accessToken,
        scopes,
      } = body;

      // Valida dados obrigatórios
      if (!domain || !accessToken || !shopifyShopId) {
        return res.status(400).json({
          error: "Dados inválidos",
          message: "domain, accessToken e shopifyShopId são obrigatórios",
        });
      }

      // Garante que são strings (não arrays)
      const safeDomain = String(domain);
      const safeAccessToken = String(accessToken);
      const safeScopes = scopes ? String(scopes) : "";
      const safeName = name ? String(name) : safeDomain;
      const safeShopifyShopId = shopifyShopId ? String(shopifyShopId) : undefined;

      // Verifica se a loja já existe
      const shop = await this.shopService.installShop({
        shopifyShopId: safeShopifyShopId,
        name: safeName,
        domain: safeDomain,
        accessToken: safeAccessToken,
        scopes: safeScopes,
      });

      return res.status(200).json({
        success: true,
        message: "Loja processada",
        shop: {
          id: shop.id,
          domain: shop.domain,
          name: shop.name,
          isActive: shop.isActive,
          createdAt: shop.createdAt,
        },
      });
    } catch (error) {
      console.error("[InstallController.install]", error);
      return res.status(500).json({
        error: "Erro interno",
        message: String(error),
      });
    }
  }

  /**
   * Busca os dados de uma loja pelo domínio
   */
  async getByDomain(req: Request, res: Response) {
    try {
      const domain = String(req.params.domain);
      const shop = await this.shopService.findByDomain(domain);

      if (!shop) {
        return res.status(404).json({ error: "Loja não encontrada" });
      }

      return res.status(200).json({
        id: shop.id,
        name: shop.name,
        domain: shop.domain,
        gateway: shop.gateway,
        isActive: shop.isActive,
        createdAt: shop.createdAt,
      });
    } catch (error) {
      console.error("[InstallController.getByDomain]", error);
      return res.status(500).json({ error: "Erro interno" });
    }
  }

  /**
   * Testa a conexão com a Shopify Admin API de uma loja
   */
  async test(req: Request, res: Response) {
    try {
      const domain = String(req.params.domain);
      const shop = await this.shopService.findByDomain(domain);

      if (!shop) {
        return res.status(404).json({ error: "Loja não encontrada" });
      }

      const shopInfo = await this.shopifyAdminService.getShopInfo(
        shop.domain,
        shop.accessToken
      );

      return res.status(200).json({
        success: true,
        shopInfo,
      });
    } catch (error) {
      console.error("[InstallController.test]", error);
      return res.status(500).json({
        error: "Erro ao conectar com Shopify",
        message: String(error),
      });
    }
  }
}