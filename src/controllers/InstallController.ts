// src/controllers/InstallController.ts
// Controller para instalação/sincronização de lojas

import { Request, Response } from "express";
import { ShopRepository } from "../repositories/ShopRepository";
import { ShopifyAdminService } from "../shopify/services/ShopifyAdminService";

export class InstallController {
  private shopService = new ShopRepository();
  private shopifyAdminService = new ShopifyAdminService();

  /**
   * Recebe os dados da loja do App Shopify e salva na API Central
   */
  async install(req: Request, res: Response) {
    try {
      const {
        shopifyShopId,
        name,
        domain,
        accessToken,
        scopes,
      } = req.body;

      // Valida dados obrigatórios
      if (!domain || !accessToken) {
        return res.status(400).json({
          error: "Dados inválidos",
          message: "domain e accessToken são obrigatórios",
        });
      }

      // Verifica se a loja já existe
      const existingShop = await this.shopService.findByDomain(domain);

      let shop;
      if (!existingShop) {
        // Cria nova loja
        shop = await this.shopService.create({
          shopifyShopId,
          name: name || domain,
          domain,
          accessToken,
          scopes: scopes || "",
        });
      } else {
        // Atualiza token e scopes
        shop = await this.shopService.updateToken(
          domain,
          accessToken,
          scopes || ""
        );
      }

      return res.status(200).json({
        success: true,
        message: existingShop ? "Loja atualizada" : "Loja criada",
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
      const { domain } = req.params;
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
      const { domain } = req.params;
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