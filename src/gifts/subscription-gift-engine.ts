// src/gifts/subscription-gift-engine.ts
// Processamento durável de brindes por loja+pedido.
//
// Garantias:
// - UMA decisão por (shopId, orderKey), mesmo com múltiplos contratos no pedido.
// - Claim atômico com lease (concorrência e webhooks simultâneos).
// - Intenção de commit persistida ANTES da chamada externa.
// - Commit incerto -> nunca inclui automaticamente de novo; confirma lendo o
//   pedido e encaminha para revisão se não confirmar.
// - Replay de eventos antigos e mudança de instalação bloqueados.
// - Desativar/configurar não afeta jobs já registrados além das regras claras:
//   PENDING sem intenção de commit é descartado; in-flight continua só para
//   confirmação; COMMITTED permanece.

import { Prisma, PrismaClient } from "@prisma/client";
import {
  GiftEligibleVariant,
  GiftShopifyClient,
  GiftShopifyCallError,
} from "./subscription-gift.shopify.client";
import {
  SUBSCRIPTION_GIFTS_LEASE_MS,
  SUBSCRIPTION_GIFTS_MAX_ATTEMPTS,
  SUBSCRIPTION_GIFTS_PROCESS_DEADLINE_MS,
  SubscriptionGiftSchedule,
  subscriptionGiftsFeatureEnabled,
} from "./subscription-gift.types";

export interface GiftEngineDependencies {
  prisma: PrismaClient;
  shopify: GiftShopifyClient;
  now?: () => Date;
  randomInt?: (max: number) => number;
  featureEnabled?: () => boolean;
  leaseMs?: number;
  deadlineMs?: number;
}

export interface GiftEngineMetrics {
  found: number;
  claimed: number;
  committed: number;
  skipped: number;
  failed: number;
  uncertain: number;
  requeued: number;
}

interface GiftJobRow {
  id: string;
  shopId: string;
  orderId: string;
  orderKey: string;
  scheduleKind: SubscriptionGiftSchedule;
  orderProcessedAt: Date | null;
  orderCurrencyCode: string | null;
  subscriptionId: string | null;
  status: string;
  chosenVariantId: string | null;
  chosenVariantSku: string | null;
  chosenProductId: string | null;
  chosenTitle: string | null;
  candidatesWithStock: number;
  candidatePoolSnapshot: unknown;
  installationGeneration: number;
  resultCode: string | null;
  resultMessage: string | null;
  orderEditId: string | null;
  calculatedOrderId: string | null;
  giftLineDeterminativeId: string | null;
  giftLineIdentifier: string | null;
  orderTotalBefore: Prisma.Decimal | string | number | null;
  orderShippingBefore: Prisma.Decimal | string | number | null;
  orderTotalAfterComputed: Prisma.Decimal | string | number | null;
  commitIntentPersistedAt: Date | null;
  attemptCount: number;
  maxAttempts: number;
  claimToken: string | null;
  claimedAt: Date | null;
  leaseExpiresAt: Date | null;
  availableAt: Date;
  lastError: string | null;
  reviewRequiredAt: Date | null;
  reviewedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const METRICS = (): GiftEngineMetrics => ({ found: 0, claimed: 0, committed: 0, skipped: 0, failed: 0, uncertain: 0, requeued: 0 });

function asNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

export class SubscriptionGiftEngine {
  private readonly now: () => Date;
  private readonly randomInt: (max: number) => number;
  private readonly featureEnabled: () => boolean;
  private readonly leaseMs: number;
  private readonly deadlineMs: number;

  constructor(private readonly dependencies: GiftEngineDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomInt = dependencies.randomInt ?? ((max) => Math.floor(Math.random() * max));
    this.featureEnabled = dependencies.featureEnabled ?? subscriptionGiftsFeatureEnabled;
    this.leaseMs = dependencies.leaseMs ?? SUBSCRIPTION_GIFTS_LEASE_MS;
    this.deadlineMs = dependencies.deadlineMs ?? SUBSCRIPTION_GIFTS_PROCESS_DEADLINE_MS;
  }

  private get prisma() {
    return this.dependencies.prisma;
  }

  private get shopifyClient() {
    return this.dependencies.shopify;
  }

  private async claimJobs(where: Record<string, unknown> & { shopId?: string }, limit: number, now: Date) {
    const claimToken = `gift:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const claimed = await this.prisma.subscriptionGiftJob.updateMany({
      where: {
        status: "PENDING",
        ...(where.shopId ? { shopId: where.shopId } : {}),
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
          { OR: [{ availableAt: { lte: now } }] },
        ],
      },
      data: { claimToken, claimedAt: now, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) },
    });
    if (!claimed.count) return [];
    const rows = await this.prisma.subscriptionGiftJob.findMany({
      where: { claimToken, ...(where.shopId ? { shopId: where.shopId } : {}) },
      orderBy: { createdAt: "asc" as const },
      take: limit,
    });
    return rows as unknown as GiftJobRow[];
  }

  async processShop(shopId: string, limit = 3, nowInput?: Date): Promise<GiftEngineMetrics> {
    const now = nowInput ?? this.now();
    const metrics = METRICS();
    const rows = await this.claimJobs({ shopId }, limit, now);
    metrics.found = rows.length;
    metrics.claimed = rows.length;
    for (const row of rows) {
      await this.processClaimedJob(row.id, now, metrics).catch((error) => {
        metrics.failed += 1;
        return this.requeueOrFail(row, "internal_error", error instanceof Error ? error.message : String(error), now, metrics);
      });
    }
    return metrics;
  }

  async processAvailable(limit = 10, nowInput?: Date): Promise<GiftEngineMetrics> {
    const now = nowInput ?? this.now();
    const metrics = METRICS();
    const rows = await this.claimJobs({}, limit, now);
    metrics.found = rows.length;
    metrics.claimed = rows.length;
    for (const row of rows) {
      await this.processClaimedJob(row.id, now, metrics).catch((error) => {
        metrics.failed += 1;
        return this.requeueOrFail(row, "internal_error", error instanceof Error ? error.message : String(error), now, metrics);
      });
    }
    return metrics;
  }

  async processClaimedJob(jobId: string, nowInput?: Date, metricsInput?: GiftEngineMetrics): Promise<GiftEngineMetrics> {
    const now = nowInput ?? this.now();
    const metrics = metricsInput ?? METRICS();
    const row = (await this.prisma.subscriptionGiftJob.findUnique({ where: { id: jobId } })) as unknown as GiftJobRow | null;
    if (!row) return metrics;
    void (await this.withDeadline(() => this.runGiftDecision(row, now, metrics)));
    return metrics;
  }

  private async withDeadline<T>(operation: () => Promise<T>): Promise<T | "deadline"> {
    const deadline = new Promise<"deadline">((resolve) => {
      setTimeout(() => resolve("deadline"), this.deadlineMs);
    });
    return Promise.race([operation(), deadline]);
  }

  // ---------------------------------------------------------------------------
  // Decisão de brinde
  // ---------------------------------------------------------------------------

  private async runGiftDecision(row: GiftJobRow, now: Date, metrics: GiftEngineMetrics): Promise<void> {
    const shop = await this.prisma.shop.findUnique({
      where: { id: row.shopId },
      select: { id: true, domain: true, accessToken: true, isActive: true, installationGeneration: true },
    });
    if (!shop) {
      return this.terminal(row, "FAILED", "installation_blocked", "Loja não encontrada para o job de brinde.", now, metrics);
    }
    if (shop.installationGeneration !== row.installationGeneration) {
      return this.terminal(row, "SKIPPED", "installation_changed", "Instalação da loja foi alterada; job de instalação antiga bloqueado.", now, metrics);
    }
    if (!shop.isActive) {
      return this.terminal(row, "SKIPPED", "installation_blocked", "Loja inativa ou desinstalada.", now, metrics);
    }
    if (!this.featureEnabled()) {
      return this.terminal(row, "SKIPPED", "feature_disabled", "Funcionalidade de brindes desativada na instalação.", now, metrics);
    }

    const settings = await this.prisma.subscriptionGiftSettings.findUnique({ where: { shopId: row.shopId } });
    if (!settings || !settings.enabled) {
      return this.terminal(row, "SKIPPED", "disabled", "Brindes desativados para esta loja.", now, metrics);
    }
    if (settings.schedule !== "BOTH" && settings.schedule !== row.scheduleKind) {
      return this.terminal(row, "SKIPPED", "schedule_no_match", `Brindes configurados para ${settings.schedule}, pedido é ${row.scheduleKind}.`, now, metrics);
    }
    if (row.orderProcessedAt && settings.enabledAt && row.orderProcessedAt < settings.enabledAt) {
      return this.terminal(row, "SKIPPED", "predates_gift_enablement", "Pedido processado antes da ativação dos brindes (sem brinde retroativo).", now, metrics);
    }

    const shopDomain = shop.domain;
    const accessToken = shop.accessToken;

    const order = await this.shopifyClient.fetchOrderForGift(shopDomain, accessToken, row.orderId);
    if (!order) {
      return this.reviewAndTerminal(row, "FAILED", "order_missing", `Pedido ${row.orderId} não encontrado na Shopify.`, now, metrics);
    }
    if (order.cancelledAt) {
      return this.terminal(row, "SKIPPED", "order_cancelled", "Pedido cancelado.", now, metrics);
    }
    if (order.displayFulfillmentStatus === "FULFILLED") {
      return this.terminal(row, "SKIPPED", "order_fulfilled", "Pedido já atendido (fulfillment concluído).", now, metrics);
    }
    if (order.displayFinancialStatus !== "PAID") {
      return this.terminal(row, "SKIPPED", "order_not_paid", `Pedido com situação financeira ${order.displayFinancialStatus ?? "desconhecida"}.`, now, metrics);
    }

    const orderTotalBefore = order.totalShopMoney;
    const orderShippingBefore = order.shippingShopMoney;

    // Montagem do grupo candidato.
    let candidateVariantIds: Array<{ variantId: string; label: string }>;
    if (settings.selectionMode === "FIXED_VARIANT") {
      if (!settings.fixedVariantId) {
        return this.terminal(row, "SKIPPED", "invalid_pool", "Variante fixa não configurada.", now, metrics);
      }
      candidateVariantIds = [{ variantId: settings.fixedVariantId, label: settings.fixedTitle ?? settings.fixedVariantId }];
    } else {
      const pool = Array.isArray(settings.variantPool) ? settings.variantPool as Array<Record<string, unknown>> : [];
      if (pool.length < 2) {
        return this.terminal(row, "SKIPPED", "invalid_pool", "Grupo de sorteio com menos de 2 variantes.", now, metrics);
      }
      candidateVariantIds = pool
        .filter((entry) => typeof entry?.variantId === "string")
        .slice(0, 50)
        .map((entry) => ({ variantId: String(entry.variantId), label: String(entry.title ?? entry.variantId) }));
    }

    const variants = await this.shopifyClient.fetchVariantEligibility(
      shopDomain,
      accessToken,
      candidateVariantIds.map((entry) => entry.variantId),
      order.servingLocationIds,
    );
    const eligible = this.filterEligible(variants);
    const eligibleById = new Map(eligible.map((variant) => [variant.variantId, variant]));

    if (!eligible.length) {
      const reason = this.describeNoStock(variants, candidateVariantIds.length, order.servingLocationIds.length);
      await this.prisma.subscriptionGiftJob.update({
        where: { id: row.id },
        data: {
          candidatesWithStock: 0,
          candidatePoolSnapshot: JSON.stringify({
            checkedAt: now.toISOString(),
            servingLocationIds: order.servingLocationIds,
            poolSize: candidateVariantIds.length,
            variants: variants.map((variant) => ({ variantId: variant.variantId, title: variant.title, available: variant.available, tracked: variant.tracked, requiresShipping: variant.requiresShipping, productActive: variant.productActive })),
          }),
        },
      });
      return this.terminal(row, "SKIPPED", "no_stock", reason, now, metrics);
    }

    let chosen: GiftEligibleVariant;
    if (settings.selectionMode === "FIXED_VARIANT") {
      const fixed = eligibleById.get(settings.fixedVariantId!);
      if (!fixed) {
        return this.terminal(row, "SKIPPED", "fixed_variant_unavailable", this.describeNoStock(variants, 1, order.servingLocationIds.length), now, metrics);
      }
      chosen = fixed;
    } else {
      const index = Math.max(0, this.randomInt(eligible.length) % eligible.length);
      chosen = eligible[index];
    }

    // Persistência da intenção de commit ANTES da chamada externa.
    await this.prisma.subscriptionGiftJob.update({
      where: { id: row.id },
      data: {
        status: "COMMIT_PENDING",
        chosenVariantId: chosen.variantId,
        chosenProductId: chosen.productId,
        chosenTitle: chosen.title,
        chosenVariantSku: chosen.sku,
        candidatesWithStock: eligible.length,
        candidatePoolSnapshot: JSON.stringify({
          chosenAt: now.toISOString(),
          servingLocationIds: order.servingLocationIds,
          poolSize: candidateVariantIds.length,
          chosenVariantId: chosen.variantId,
          eligible: eligible.map((variant) => ({ variantId: variant.variantId, title: variant.title, available: variant.available })),
        }),
        orderTotalBefore: new Prisma.Decimal(orderTotalBefore.toFixed(2)),
        orderShippingBefore: new Prisma.Decimal(orderShippingBefore.toFixed(2)),
        commitIntentPersistedAt: now,
        attemptCount: { increment: 1 },
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
      },
    });

    await this.applyGiftToOrder(
      row,
      chosen,
      orderTotalBefore,
      orderShippingBefore,
      shopDomain,
      accessToken,
      order.servingLocationIds.length === 1 ? order.servingLocationIds[0] : null,
      now,
      metrics,
    );
  }

  private filterEligible(variants: GiftEligibleVariant[]): GiftEligibleVariant[] {
    return variants.filter(
      (variant) =>
        variant.productActive &&
        variant.tracked &&
        variant.requiresShipping &&
        variant.availableAtLocation,
    );
  }

  private describeNoStock(variants: GiftEligibleVariant[], poolSize: number, locationCount: number): string {
    if (!variants.length) {
      return "Nenhum candidato encontrado no catálogo (produto removido, inativo ou variante excluída).";
    }
    const byReason: string[] = [];
    if (!variants.some((variant) => variant.availableAtLocation)) {
      byReason.push("nenhuma variante com estoque disponível");
    }
    if (!variants.some((variant) => variant.tracked)) {
      byReason.push("nenhuma variante com estoque controlado pela Shopify");
    }
    if (!variants.some((variant) => variant.requiresShipping)) {
      byReason.push("nenhuma variante de produto físico");
    }
    if (!variants.some((variant) => variant.productActive)) {
      byReason.push("produto inativo ou arquivado");
    }
    return `Sem candidatos com estoque para o local de atendimento${locationCount ? "" : " (nenhum local atribuído no pedido)"}. ${byReason.join("; ")}.`;
  }

  // ---------------------------------------------------------------------------
  // Aplicação no pedido via Order Edit
  // ---------------------------------------------------------------------------

  private async applyGiftToOrder(
    row: GiftJobRow,
    chosen: GiftEligibleVariant,
    orderTotalBefore: number,
    orderShippingBefore: number,
    shopDomain: string,
    accessToken: string,
    servingLocationId: string | null,
    now: Date,
    metrics: GiftEngineMetrics,
  ): Promise<void> {
    try {
      const begun = await this.shopifyClient.orderEditBegin(shopDomain, accessToken, row.orderId);
      const beginPayload = begun.data?.orderEditBegin;
      if (beginPayload?.userErrors?.length) {
        return this.handleUserErrors(row, "orderEditBegin", beginPayload.userErrors, now, metrics);
      }
      const calculatedOrderId = beginPayload?.calculatedOrder?.id;
      if (!calculatedOrderId) {
        return this.failTerminal(row, "order_not_editable", "Order edit não retornou CalculatedOrder.", now, metrics);
      }
      await this.prisma.subscriptionGiftJob.update({
        where: { id: row.id },
        data: { calculatedOrderId, orderEditId: calculatedOrderId },
      });

      const added = await this.shopifyClient.orderEditAddVariant(
        shopDomain,
        accessToken,
        calculatedOrderId,
        chosen.variantId,
        servingLocationId,
      );
      const addPayload = added.data?.orderEditAddVariant;
      if (addPayload?.userErrors?.length) {
        return this.handleUserErrors(row, "orderEditAddVariant", addPayload.userErrors, now, metrics);
      }
      const giftLineId = addPayload?.calculatedLineItem?.id ?? null;
      if (!giftLineId) {
        return this.failTerminal(row, "order_not_editable", "Linha do brinde não retornada no Order Edit.", now, metrics);
      }
      await this.prisma.subscriptionGiftJob.update({
        where: { id: row.id },
        data: { giftLineDeterminativeId: giftLineId },
      });

      const discounted = await this.shopifyClient.orderEditAddLineItemDiscount(
        shopDomain,
        accessToken,
        calculatedOrderId,
        giftLineId,
      );
      const discountPayload = discounted.data?.orderEditAddLineItemDiscount;
      if (discountPayload?.userErrors?.length) {
        return this.handleUserErrors(row, "orderEditAddLineItemDiscount", discountPayload.userErrors, now, metrics);
      }

      const finalCalculated = discountPayload?.calculatedOrder ?? addPayload?.calculatedOrder;
      const newTotal = finalCalculated ? asNumber(finalCalculated.totalPriceSet?.shopMoney?.amount) : orderTotalBefore;
      const newShipping = finalCalculated
        ? (finalCalculated.shippingLines ?? []).reduce((sum, line) => sum + asNumber(line.price?.shopMoney?.amount), 0)
        : orderShippingBefore;

      const totalIncreased = newTotal > orderTotalBefore + 0.005;
      const shippingIncreased = newShipping > orderShippingBefore + 0.005;
      if (totalIncreased || shippingIncreased) {
        return this.terminal(
          row,
          "SKIPPED",
          "would_increase_total",
          `Edição aumentaria o total (antes ${orderTotalBefore.toFixed(2)} -> ${newTotal.toFixed(2)})${shippingIncreased ? ` ou o frete (antes ${orderShippingBefore.toFixed(2)} -> ${newShipping.toFixed(2)})` : ""}. Brinde não commitado.`,
          now,
          metrics,
        );
      }
      await this.prisma.subscriptionGiftJob.update({
        where: { id: row.id },
        data: { orderTotalAfterComputed: new Prisma.Decimal(newTotal.toFixed(2)) },
      });

      let commitResult;
      try {
        commitResult = await this.shopifyClient.orderEditCommit(shopDomain, accessToken, calculatedOrderId, `Brinde APS: ${chosen.title}`);
      } catch (error) {
        // Commit com resposta incerta: NUNCA incluir de novo automaticamente.
        await this.prisma.subscriptionGiftJob.update({
          where: { id: row.id },
          data: {
            status: "UNCERTAIN",
            resultCode: "commit_uncertain",
            resultMessage: "Resultado do commit incerto (timeout/falha de rede). Aguardando confirmação pela leitura do pedido.",
            reviewRequiredAt: now,
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
        metrics.uncertain += 1;
        await this.confirmJob(row.id, shopDomain, accessToken, now);
        return;
      }
      const commitPayload = commitResult.data?.orderEditCommit;
      if (commitPayload?.userErrors?.length) {
        return this.handleUserErrors(row, "orderEditCommit", commitPayload.userErrors, now, metrics);
      }
      await this.terminal(row, "COMMITTED", "gift_added", `Brinde adicionado ao pedido: ${chosen.title}.`, now, metrics);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return this.requeueOrTimeout(row, now, metrics);
      }
      if (isGiftShopifyCallError(error) && error.kind === "timeout") {
        return this.requeueOrTimeout(row, now, metrics);
      }
      return this.requeueOrFail(row, "internal_error", error instanceof Error ? error.message : String(error), now, metrics);
    }
  }

  private async handleUserErrors(
    row: GiftJobRow,
    step: string,
    errors: Array<{ message: string }>,
    now: Date,
    metrics: GiftEngineMetrics,
  ): Promise<void> {
    const combined = errors.map((error) => error.message).join("; ");
    const lower = combined.toLowerCase();
    if (lower.includes("scope") || lower.includes("permission") || lower.includes("forbidden") || lower.includes("access denied") || lower.includes("write_order_edits")) {
      await this.prisma.subscriptionGiftJob.update({
        where: { id: row.id },
        data: { resultCode: "scope_missing", resultMessage: `Permissão write_order_edits ausente no passo ${step}: ${combined}`, reviewRequiredAt: now },
      });
      metrics.failed += 1;
      return;
    }
    if (step === "orderEditCommit") {
      // Resposta definitiva: não aplicou. Encaminha para revisão; não tenta de novo.
      return this.failTerminal(row, "commit_rejected", `Commit rejeitado pela Shopify no passo ${step}: ${combined}`, now, metrics);
    }
    if (lower.includes("inventory") || lower.includes("stock") || lower.includes("not available")) {
      // Estoque disputado entre a checagem e o commit: nova tentativa limitada.
      return this.requeueOrFail(row, "no_stock", `${step}: ${combined}`, now, metrics);
    }
    return this.requeueOrFail(row, "commit_rejected", `${step}: ${combined}`, now, metrics);
  }

  // Confirmação do resultado incerto consultando a linha gratuita no pedido.
  private async confirmJob(jobId: string, shopDomain: string, accessToken: string, now: Date): Promise<boolean> {
    try {
      const row = (await this.prisma.subscriptionGiftJob.findUnique({ where: { id: jobId } })) as unknown as GiftJobRow | null;
      if (!row?.chosenVariantId) return false;
      const lines = await this.shopifyClient.queryOrderGiftLines(shopDomain, accessToken, row.orderId, row.chosenVariantId);
      const freeLine = lines.find((line) => line.discountedUnitPrice === 0) ?? null;
      if (freeLine) {
        await this.prisma.subscriptionGiftJob.update({
          where: { id: jobId },
          data: {
            status: "COMMITTED",
            resultCode: "gift_confirmed",
            resultMessage: `Linha gratuita confirmada no pedido: ${freeLine.title}.`,
            giftLineIdentifier: freeLine.lineId,
            reviewRequiredAt: null,
            processedAt: now,
          },
        });
        return true;
      }
      if (lines.length) {
        await this.prisma.subscriptionGiftJob.update({
          where: { id: jobId },
          data: {
            status: "UNCERTAIN",
            resultCode: "commit_charged",
            resultMessage: `Linha do brinde presente porém cobrada (${lines[0].discountedUnitPrice}). Revisão necessária.`,
            reviewRequiredAt: now,
          },
        });
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  async recoverStale(nowInput?: Date): Promise<GiftEngineMetrics> {
    const now = nowInput ?? this.now();
    const metrics = METRICS();
    // COMMIT_PENDING com lease expirado: o resultado do commit é desconhecido.
    const stale = await this.prisma.subscriptionGiftJob.updateMany({
      where: {
        status: "COMMIT_PENDING",
        commitIntentPersistedAt: { not: null },
        leaseExpiresAt: { lt: now },
        reviewedAt: null,
      },
      data: {
        status: "UNCERTAIN",
        resultCode: "commit_uncertain",
        resultMessage: "Intenção de commit persistida mas resultado não confirmado; encaminhado para revisão.",
        reviewRequiredAt: now,
        claimToken: null,
        claimedAt: null,
      },
    });
    metrics.uncertain += stale.count;

    // PENDING com lease expirado (crash antes da decisão): libera para nova tentativa.
    await this.prisma.subscriptionGiftJob.updateMany({
      where: {
        status: "PENDING",
        leaseExpiresAt: { lt: now },
        claimedAt: { not: null },
      },
      data: { claimedAt: null, leaseExpiresAt: null, availableAt: now },
    });

    const uncertain = await this.prisma.subscriptionGiftJob.findMany({
      where: { status: "UNCERTAIN", reviewRequiredAt: { not: null }, updatedAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) } },
      take: 20,
    });
    for (const candidate of uncertain as unknown as GiftJobRow[]) {
      const shop = await this.prisma.shop.findUnique({
        where: { id: candidate.shopId },
        select: { domain: true, accessToken: true },
      });
      if (shop) {
        const confirmed = await this.confirmJob(candidate.id, shop.domain, shop.accessToken, now);
        if (confirmed) metrics.committed += 1;
      }
    }

    const staleUncertain = await this.prisma.subscriptionGiftJob.updateMany({
      where: {
        status: "UNCERTAIN",
        reviewRequiredAt: { not: null },
        updatedAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) },
      },
      data: { reviewedAt: now },
    });
    metrics.skipped += staleUncertain.count;
    return metrics;
  }

  // ---------------------------------------------------------------------------
  // Resultados
  // ---------------------------------------------------------------------------

  private async terminal(
    row: GiftJobRow,
    status: "COMMITTED" | "SKIPPED" | "FAILED" | "UNCERTAIN",
    resultCode: string,
    resultMessage: string,
    now: Date,
    metrics: GiftEngineMetrics,
  ): Promise<void> {
    await this.prisma.subscriptionGiftJob.update({
      where: { id: row.id },
      data: {
        status,
        resultCode,
        resultMessage,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        processedAt: now,
      },
    });
    if (status === "COMMITTED") metrics.committed += 1;
    else if (status === "SKIPPED") metrics.skipped += 1;
    else if (status === "FAILED") metrics.failed += 1;
    else metrics.uncertain += 1;
  }

  private async reviewAndTerminal(
    row: GiftJobRow,
    status: "FAILED" | "SKIPPED",
    resultCode: string,
    resultMessage: string,
    now: Date,
    metrics: GiftEngineMetrics,
  ): Promise<void> {
    await this.prisma.subscriptionGiftJob.update({
      where: { id: row.id },
      data: {
        status,
        resultCode,
        resultMessage,
        reviewRequiredAt: now,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        processedAt: now,
      },
    });
    if (status === "FAILED") metrics.failed += 1;
    else metrics.skipped += 1;
  }

  private async failTerminal(row: GiftJobRow, resultCode: string, resultMessage: string, now: Date, metrics: GiftEngineMetrics): Promise<void> {
    await this.prisma.subscriptionGiftJob.update({
      where: { id: row.id },
      data: {
        status: "FAILED",
        resultCode,
        resultMessage,
        reviewRequiredAt: now,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        processedAt: now,
      },
    });
    metrics.failed += 1;
  }

  private async requeueOrFail(row: GiftJobRow, resultCode: string, message: string, now: Date, metrics: GiftEngineMetrics): Promise<void> {
    const attemptCount = (row.attemptCount ?? 0) + 1;
    const maxAttempts = row.maxAttempts ?? SUBSCRIPTION_GIFTS_MAX_ATTEMPTS;
    if (attemptCount >= maxAttempts) {
      await this.prisma.subscriptionGiftJob.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          resultCode,
          resultMessage: message,
          lastError: message,
          reviewRequiredAt: now,
          claimToken: null,
          claimedAt: null,
          leaseExpiresAt: null,
          processedAt: now,
        },
      });
      metrics.failed += 1;
      return;
    }
    const backoffMs = Math.min(60 * 60 * 1000, 2 ** attemptCount * 30 * 1000);
    await this.prisma.subscriptionGiftJob.update({
      where: { id: row.id },
      data: {
        status: "PENDING",
        resultCode: resultCode === "internal_error" ? null : resultCode,
        resultMessage: null,
        lastError: message,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        availableAt: new Date(now.getTime() + backoffMs),
      },
    });
    metrics.requeued += 1;
  }

  private async requeueOrTimeout(row: GiftJobRow, now: Date, metrics: GiftEngineMetrics): Promise<void> {
    await this.requeueOrFail(row, "commit_uncertain", "Tempo esgotado durante o Order Edit.", now, metrics);
  }
}

function isGiftShopifyCallError(error: unknown): error is GiftShopifyCallError {
  return Boolean(error && typeof error === "object" && "kind" in error && "message" in error);
}