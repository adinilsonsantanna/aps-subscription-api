import { Request, Response } from "express";
import { PrismaShopifyEventRepository } from "../shopify/events/shopify-event.repository";
import { ShopifyEventIngestionService } from "../shopify/events/shopify-event.service";
import {
  ShopifyEventValidationError,
  ShopifyShopNotFoundError,
} from "../shopify/events/shopify-event.types";

export class ShopifyEventController {
  private readonly service = new ShopifyEventIngestionService(
    new PrismaShopifyEventRepository(),
  );

  async create(req: Request, res: Response) {
    try {
      const result = await this.service.ingest(req.body);
      return res.status(200).json({ success: true, ...result });
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
}
