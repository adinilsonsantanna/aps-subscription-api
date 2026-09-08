import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { PrismaShopifyEventRepository } from "../shopify/events/shopify-event.repository";
import { ShopifyEventIngestionService } from "../shopify/events/shopify-event.service";
import {
  ShopifyEventValidationError,
  ShopifyShopNotFoundError,
} from "../shopify/events/shopify-event.types";
import { SubscriptionGiftEngine } from "../gifts/subscription-gift-engine";
import { GiftShopifyClient } from "../gifts/subscription-gift.shopify.client";
import { subscriptionGiftsFeatureEnabled } from "../gifts/subscription-gift.types";

export class ShopifyEventController {
  private readonly repository = new PrismaShopifyEventRepository();
  private readonly service = new ShopifyEventIngestionService(this.repository);

  constructor(private prisma = new PrismaClient()) {}

  async create(req: Request, res: Response) {
    try {
      const result = await this.service.ingest(req.body);
      res.status(200).json({ success: true, ...result });
      // Processamento inline best effort, ~6s, sem bloquear a resposta do
      // webhook. Se o runtime encerrar antes, o lease expira e o cron retoma.
      this.triggerGifts(String(req.body?.shop)).catch(() => undefined);
      return;
    } catch (error) {
      if (error instanceof ShopifyEventValidationError) {
        return res.status(400).json({ error: error.message });
      }
      if (error instanceof ShopifyShopNotFoundError) {
        return res.status(404).json({ error: "Shop not found" });
      }

      console.error("[ShopifyEventController] Event processing failed", {
        topic: typeof req.body?.topic === "string" ? req.body.topic : "unknown",
        shop: typeof req.body?.shop === "string" ? req.body.shop : "unknown",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      return res.status(500).json({ error: "Event processing failed" });
    }
  }

  private async triggerGifts(shopDomain?: string) {
    if (!shopDomain || !subscriptionGiftsFeatureEnabled()) return;
    const shop = await this.repository.findShopByDomain(shopDomain);
    if (!shop) return;
    const engine = new SubscriptionGiftEngine({ prisma: this.prisma, shopify: new GiftShopifyClient() });
    const bounded = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 6_000);
    });
    await Promise.race([engine.processShop(shop.id, 2), bounded]);
  }
}