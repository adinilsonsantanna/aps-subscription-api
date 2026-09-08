// src/gifts/subscription-gift.jobs.ts
// Enfileiramento durável de decisões de brinde por loja+pedido, dentro da
// transação de ingestão de webhook. A unicidade (shopId, orderKey) garante
// UMA decisão por pedido mesmo com vários contratos no mesmo pedido ou
// webhooks repetidos.

import { Prisma } from "@prisma/client";
import {
  SUBSCRIPTION_GIFTS_ORDER_AGE_ACCEPT_HOURS,
  SubscriptionGiftSchedule,
} from "./subscription-gift.types";

export interface EnqueueGiftJobInput {
  shopId: string;
  installationGeneration: number;
  orderId: string | null | undefined;
  orderProcessedAt?: Date | string | null;
  orderCurrencyCode?: string | null;
  subscriptionId?: string | null;
  scheduleKind: SubscriptionGiftSchedule;
}

export interface EnqueueGiftJobResult {
  created: boolean;
  existing: boolean;
  skipped?: boolean;
  reason?: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function enqueueGiftJob(
  transaction: Prisma.TransactionClient,
  input: EnqueueGiftJobInput,
  now = new Date(),
): Promise<EnqueueGiftJobResult> {
  if (!input.orderId) return Promise.resolve({ created: false, existing: false, skipped: true, reason: "order_id_missing" });

  // Fence anti-replay: só aceitamos pedidos processados recentemente. Replays
  // de eventos antigos não criam job e, portanto, nunca distribuem brinde.
  const processedAt = input.orderProcessedAt ? new Date(input.orderProcessedAt) : null;
  if (processedAt && !Number.isNaN(processedAt.getTime())) {
    const oldestAccepted = new Date(now.getTime() - SUBSCRIPTION_GIFTS_ORDER_AGE_ACCEPT_HOURS * HOUR_MS);
    if (processedAt < oldestAccepted) {
      return Promise.resolve({
        created: false,
        existing: false,
        skipped: true,
        reason: "order_too_old",
      });
    }
  }

  const orderKey = `${input.shopId}:${input.orderId}`;
  return transaction.subscriptionGiftJob
    .upsert({
      where: { shopId_orderKey: { shopId: input.shopId, orderKey } },
      create: {
        shopId: input.shopId,
        orderId: input.orderId,
        orderKey,
        scheduleKind: input.scheduleKind,
        ...(processedAt && !Number.isNaN(processedAt.getTime()) ? { orderProcessedAt: processedAt } : {}),
        ...(input.orderCurrencyCode ? { orderCurrencyCode: input.orderCurrencyCode } : {}),
        ...(input.subscriptionId ? { subscriptionId: input.subscriptionId } : {}),
        installationGeneration: input.installationGeneration,
        status: "PENDING",
      },
      update: {},
      select: { id: true },
    })
    .then(() => ({ created: true, existing: false }))
    .catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // Outro contrato do mesmo pedido ou webhook repetido já registrou.
        return { created: false, existing: true } as EnqueueGiftJobResult;
      }
      throw error;
    });
}

export interface GiftJobView {
  id: string;
  orderId: string;
  orderProcessedAt: string | null;
  status: string;
  scheduleKind: SubscriptionGiftSchedule;
  chosenVariantId: string | null;
  chosenTitle: string | null;
  chosenVariantSku: string | null;
  resultCode: string | null;
  resultMessage: string | null;
  candidatesWithStock: number;
  attemptCount: number;
  reviewRequired: boolean;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function mapGiftJobView(job: {
  id: string;
  orderId: string;
  orderProcessedAt: Date | null;
  status: string;
  scheduleKind: SubscriptionGiftSchedule;
  chosenVariantId: string | null;
  chosenTitle: string | null;
  chosenVariantSku: string | null;
  resultCode: string | null;
  resultMessage: string | null;
  candidatesWithStock: number;
  attemptCount: number;
  reviewRequiredAt: Date | null;
  reviewedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): GiftJobView {
  return {
    id: job.id,
    orderId: job.orderId,
    orderProcessedAt: job.orderProcessedAt ? job.orderProcessedAt.toISOString() : null,
    status: job.status,
    scheduleKind: job.scheduleKind,
    chosenVariantId: job.chosenVariantId,
    chosenTitle: job.chosenTitle,
    chosenVariantSku: job.chosenVariantSku,
    resultCode: job.resultCode,
    resultMessage: job.resultMessage,
    candidatesWithStock: job.candidatesWithStock,
    attemptCount: job.attemptCount,
    reviewRequired: job.reviewRequiredAt !== null && job.reviewedAt === null,
    processedAt: job.processedAt ? job.processedAt.toISOString() : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}