import { Prisma } from "@prisma/client";
import { ShopifyEventRepository } from "./shopify-event.repository";
import {
  ShopifyShopNotFoundError,
  validateIncomingShopifyEvent,
} from "./shopify-event.types";

export interface ShopifyEventIngestionResult {
  duplicate: boolean;
  processed: boolean;
}

export class ShopifyEventIngestionService {
  constructor(private readonly repository: ShopifyEventRepository) {}

  async ingest(body: unknown): Promise<ShopifyEventIngestionResult> {
    const event = validateIncomingShopifyEvent(body);
    let existingEvent = await this.repository.findEventById(event.webhookId);

    if (existingEvent?.processed) {
      return { duplicate: true, processed: true };
    }

    const shop = await this.repository.findShopByDomain(event.shop);
    if (!shop) {
      throw new ShopifyShopNotFoundError("Shop not found");
    }

    let duplicate = Boolean(existingEvent);
    if (!existingEvent) {
      try {
        await this.repository.createEvent(event, shop.id);
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
          throw error;
        }

        duplicate = true;
        existingEvent = await this.repository.findEventById(event.webhookId);
        if (existingEvent?.processed) {
          return { duplicate: true, processed: true };
        }
      }
    }

    try {
      await this.repository.processEvent(event, shop.id);
      return { duplicate, processed: true };
    } catch (error) {
      await this.repository.markEventFailed(
        event.webhookId,
        `Processing failed for topic ${event.topic}`,
      );
      throw error;
    }
  }
}
