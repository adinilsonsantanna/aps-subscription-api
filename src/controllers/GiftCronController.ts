// src/controllers/GiftCronController.ts
// Rotina recorrente de processamento de brindes. Autentica via CRON_SECRET e
// aciona o motor durável (claim/lease/commit-intent). Frequência sugerida:
// a cada 10 minutos (vercel.json), pois o processamento de cada pedido é
// independente e idempotente — a recovery diária por si só NÃO é suficiente.

import { timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { SubscriptionGiftEngine } from "../gifts/subscription-gift-engine";
import { GiftShopifyClient } from "../gifts/subscription-gift.shopify.client";
import { subscriptionGiftsFeatureEnabled } from "../gifts/subscription-gift.types";

export class GiftCronController {
  constructor(private prisma = new PrismaClient()) {}

  async run(req: Request, res: Response) {
    const expected = process.env.CRON_SECRET || "", received = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const valid = expected && Buffer.byteLength(expected) === Buffer.byteLength(received) && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!valid) return res.status(401).json({ error: "unauthorized" });

    if (!subscriptionGiftsFeatureEnabled()) {
      return res.status(200).json({ success: true, disabled: true, reason: "ENABLE_SUBSCRIPTION_GIFTS nao habilitado" });
    }

    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
    const engine = new SubscriptionGiftEngine({ prisma: this.prisma, shopify: new GiftShopifyClient() });
    const shopId = typeof req.query.shopId === "string" ? req.query.shopId : undefined;

    try {
      const recovery = await engine.recoverStale();
      const processing = shopId ? await engine.processShop(shopId, limit) : await engine.processAvailable(limit);
      const body = {
        success: true,
        shopId: shopId ?? null,
        recovery,
        processing,
      };
      return res.status(200).json(body);
    } catch (error) {
      console.error("[GiftCronController] Falha ao processar brindes", { shopId, error: error instanceof Error ? error.message : String(error) });
      return res.status(500).json({ success: false, error: error instanceof Error ? error.message.slice(0, 250) : "gift_cron_failed" });
    }
  }
}