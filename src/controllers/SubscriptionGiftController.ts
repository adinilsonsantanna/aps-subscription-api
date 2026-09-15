// src/controllers/SubscriptionGiftController.ts
// Leitura/gravação da configuração de brindes e histórico de inclusões por loja.
// A autenticação é feita pelo middleware apiAuth (x-api-key) no roteamento.

import { PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import { GiftSettingsService } from "../gifts/subscription-gift.settings.service";
import { SubscriptionGiftValidationError } from "../gifts/subscription-gift-validation";
import { subscriptionGiftsFeatureEnabled, SubscriptionGiftJobStatus } from "../gifts/subscription-gift.types";

export class SubscriptionGiftController {
  private readonly settingsService: GiftSettingsService;

  constructor(private prisma = new PrismaClient()) {
    this.settingsService = new GiftSettingsService({ prisma });
  }

  private async shop(domain: string) {
    return this.prisma.shop.findUnique({ where: { domain: domain.toLowerCase() }, select: { id: true, domain: true } });
  }

  async getSettings(req: Request, res: Response) {
    const shop = await this.shop(String(req.params.shop));
    if (!shop) return res.status(404).json({ error: "shop_not_found" });
    const settings = await this.settingsService.get(shop.id);
    return res.json({
      shop: shop.domain,
      featureEnabled: subscriptionGiftsFeatureEnabled(),
      settings,
    });
  }

  async saveSettings(req: Request, res: Response) {
    const shop = await this.shop(String(req.params.shop));
    if (!shop) return res.status(404).json({ error: "shop_not_found" });
    if (!subscriptionGiftsFeatureEnabled()) {
      return res.status(403).json({ error: "feature_disabled", message: "Funcionalidade de brindes desativada na instalação." });
    }
    try {
      const result = await this.settingsService.save(shop.id, req.body);
      return res.json({ shop: shop.domain, persisted: true, ...result });
    } catch (error) {
      if (error instanceof SubscriptionGiftValidationError) {
        return res.status(400).json({ error: error.message });
      }
      console.error("[SubscriptionGiftController] Falha ao salvar configuração", { shop, error: error instanceof Error ? error.message : String(error) });
      return res.status(500).json({ error: "save_settings_failed" });
    }
  }

  async history(req: Request, res: Response) {
    const shop = await this.shop(String(req.params.shop));
    if (!shop) return res.status(404).json({ error: "shop_not_found" });
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const status = typeof req.query.status === "string" && req.query.status ? String(req.query.status) : undefined;
    const jobs = await this.prisma.subscriptionGiftJob.findMany({
      where: { shopId: shop.id, ...(status ? { status: status as SubscriptionGiftJobStatus } : {}) },
      orderBy: { createdAt: "desc" as const },
      take: limit,
      select: {
        id: true,
        orderId: true,
        orderProcessedAt: true,
        scheduleKind: true,
        status: true,
        chosenVariantId: true,
        chosenTitle: true,
        chosenVariantSku: true,
        candidatesWithStock: true,
        resultCode: true,
        resultMessage: true,
        attemptCount: true,
        reviewRequiredAt: true,
        reviewedAt: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return res.json({ shop: shop.domain, jobs });
  }

  async processShop(req: Request, res: Response) {
    const shop = await this.shop(String(req.params.shop));
    if (!shop) return res.status(404).json({ error: "shop_not_found" });
    if (!subscriptionGiftsFeatureEnabled()) {
      return res.status(200).json({ success: true, disabled: true, reason: "feature_disabled" });
    }
    const { SubscriptionGiftEngine } = await import("../gifts/subscription-gift-engine");
    const { GiftShopifyClient } = await import("../gifts/subscription-gift.shopify.client");
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
    const engine = new SubscriptionGiftEngine({ prisma: this.prisma, shopify: new GiftShopifyClient() });
    const recovery = await engine.recoverStale();
    const processing = await engine.processShop(shop.id, limit);
    return res.status(200).json({ success: true, recovery, processing });
  }
}