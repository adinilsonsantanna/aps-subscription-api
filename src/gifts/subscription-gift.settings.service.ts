// src/gifts/subscription-gift.settings.service.ts
// Persistência e leitura das configurações de brinde por loja, gating global.

import { Prisma, PrismaClient } from "@prisma/client";
import {
  SubscriptionGiftSchedule,
  SubscriptionGiftSelectionMode,
  SubscriptionGiftSettingsInput,
  SubscriptionGiftSettingsView,
} from "./subscription-gift.types";
import { validateGiftSettingsInput, SubscriptionGiftValidationError } from "./subscription-gift-validation";

export interface GiftSettingsServiceDependencies {
  prisma: PrismaClient;
  now?: () => Date;
}

export function mapGiftSettingsView(settings: {
  enabled: boolean;
  enabledAt: Date | null;
  schedule: SubscriptionGiftSchedule;
  selectionMode: SubscriptionGiftSelectionMode;
  fixedVariantId: string | null;
  fixedProductId: string | null;
  fixedTitle: string | null;
  fixedSku: string | null;
  variantPool: unknown;
  maxPoolSize: number;
  createdAt: Date;
  updatedAt: Date;
}): SubscriptionGiftSettingsView {
  return {
    enabled: settings.enabled,
    enabledAt: settings.enabledAt ? settings.enabledAt.toISOString() : null,
    schedule: settings.schedule,
    selectionMode: settings.selectionMode,
    fixedVariantId: settings.fixedVariantId,
    fixedProductId: settings.fixedProductId,
    fixedTitle: settings.fixedTitle,
    fixedSku: settings.fixedSku,
    variantPool: Array.isArray(settings.variantPool) ? settings.variantPool : [],
    maxPoolSize: settings.maxPoolSize,
    createdAt: settings.createdAt.toISOString(),
    updatedAt: settings.updatedAt.toISOString(),
  };
}

export class GiftSettingsService {
  constructor(private readonly dependencies: GiftSettingsServiceDependencies) {}

  async get(shopId: string) {
    const settings = await this.dependencies.prisma.subscriptionGiftSettings.findUnique({
      where: { shopId },
    });
    return settings ? mapGiftSettingsView(settings) : null;
  }

  /**
   * Atualiza (upsert) a configuração. Quando enabled transiciona para true,
   * registra enabledAt (fence de ordem: só pedidos processados depois disso
   * recebem brinde — bloqueia replay de eventos antigos). Quando transiciona
   * para false, marca como SKIPPED os jobs PENDING sem intenção de commit
   * persistida, deixando os in-flight continuarem apenas para confirmação.
   */
  async save(shopId: string, input: unknown): Promise<{ settings: SubscriptionGiftSettingsView; skippedJobs: number }> {
    const data = validateGiftSettingsInput(input);
    const now = this.dependencies.now?.() ?? new Date();
    const existing = await this.dependencies.prisma.subscriptionGiftSettings.findUnique({
      where: { shopId },
      select: { enabled: true, enabledAt: true },
    });
    const wasEnabled = existing?.enabled === true;
    const enabledAt = data.enabled && !wasEnabled ? now : existing?.enabledAt ?? null;

    const settings = await this.dependencies.prisma.subscriptionGiftSettings.upsert({
      where: { shopId },
      create: {
        shopId,
        ...data,
        ...(enabledAt ? { enabledAt } : {}),
        variantPool: data.variantPool as unknown as Prisma.InputJsonValue,
      },
      update: {
        ...data,
        enabledAt,
        variantPool: data.variantPool as unknown as Prisma.InputJsonValue,
      },
    });

    let skippedJobs = 0;
    if (wasEnabled && !data.enabled) {
      const disabled = await this.dependencies.prisma.subscriptionGiftJob.updateMany({
        where: {
          shopId,
          status: "PENDING",
          commitIntentPersistedAt: null,
        },
        data: {
          status: "SKIPPED",
          resultCode: "disabled",
          resultMessage: "Brindes desativados antes do processamento deste pedido.",
          processedAt: now,
        },
      });
      skippedJobs = disabled.count;
    }

    return { settings: mapGiftSettingsView(settings), skippedJobs };
  }
}