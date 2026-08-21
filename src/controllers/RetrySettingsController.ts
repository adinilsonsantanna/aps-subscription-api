import { PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import { RETRY_DEFAULTS, validateRetrySettings } from "../retry/retry-settings";

export class RetrySettingsController {
  constructor(private prisma = new PrismaClient()) {}
  private async shop(domain: string) { return this.prisma.shop.findUnique({ where: { domain: domain.toLowerCase() }, select: { id: true, domain: true } }); }
  async get(req: Request, res: Response) {
    const shop = await this.shop(String(req.params.shop));
    if (!shop) return res.status(404).json({ error: "shop_not_found" });
    const settings = await this.prisma.billingRetrySettings.findUnique({ where: { shopId: shop.id } });
    return res.json({ shop: shop.domain, persisted: Boolean(settings), settings: settings ?? { shopId: shop.id, ...RETRY_DEFAULTS, createdAt: null, updatedAt: null } });
  }
  async put(req: Request, res: Response) {
    const shop = await this.shop(String(req.params.shop));
    if (!shop) return res.status(404).json({ error: "shop_not_found" });
    try {
      const data = validateRetrySettings(req.body);
      const settings = await this.prisma.billingRetrySettings.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, ...data }, update: data });
      return res.json({ shop: shop.domain, persisted: true, settings });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "invalid_settings" });
    }
  }
}
