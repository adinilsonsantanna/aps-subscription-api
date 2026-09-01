import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { canonicalizeShopId } from "../../utils/shopId";
import {
  recordAdministrativeReconciliationPrismaStage,
  type AdministrativeReconciliationPrismaStage,
} from "./prisma-observability";

export type AdministrativeBillingReconciliationInput = {
  shopDomain: string; shopId: string; subscriptionContractId: string;
  subscriptionBillingAttemptId: string; shopifyOrderId: string; cycleOriginTime: string;
  status: "succeeded"; amount: string; currencyCode: string; attemptedAt: string;
  completedAt: string; orderProcessedAt: string; test: true; gateway: "bogus"; correlationId: string; dryRun: boolean;
};
export class AdministrativeReconciliationError extends Error { constructor(public readonly statusCode: number, public readonly code: string) { super(code); } }

const gid = (value: unknown, resource: string) => typeof value === "string" && new RegExp(`^gid://shopify/${resource}/[1-9][0-9]*$`).test(value);
const iso = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
export function validateAdministrativeBillingReconciliation(value: unknown): AdministrativeBillingReconciliationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdministrativeReconciliationError(400, "invalid_payload");
  const v = value as Record<string, unknown>;
  const keys = ["shopDomain", "shopId", "subscriptionContractId", "subscriptionBillingAttemptId", "shopifyOrderId", "cycleOriginTime", "status", "amount", "currencyCode", "attemptedAt", "completedAt", "orderProcessedAt", "test", "gateway", "correlationId", "dryRun"];
  if (Object.keys(v).some(key => !keys.includes(key))) throw new AdministrativeReconciliationError(400, "unexpected_field");
  if (typeof v.shopDomain !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(v.shopDomain) || !gid(v.shopId, "Shop") || !gid(v.subscriptionContractId, "SubscriptionContract") || !gid(v.subscriptionBillingAttemptId, "SubscriptionBillingAttempt") || !gid(v.shopifyOrderId, "Order")) throw new AdministrativeReconciliationError(400, "invalid_identity");
  if (!iso(v.cycleOriginTime) || !iso(v.attemptedAt) || !iso(v.completedAt) || !iso(v.orderProcessedAt) || v.status !== "succeeded" || v.test !== true || v.gateway !== "bogus") throw new AdministrativeReconciliationError(400, "invalid_shopify_state");
  if (typeof v.amount !== "string" || !/^(?:0*[1-9]\d*)(?:\.\d{1,2})?$/.test(v.amount) || typeof v.currencyCode !== "string" || !/^[A-Z]{3}$/.test(v.currencyCode) || typeof v.correlationId !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(v.correlationId) || typeof v.dryRun !== "boolean") throw new AdministrativeReconciliationError(400, "invalid_reconciliation_data");
  return { ...(v as AdministrativeBillingReconciliationInput), shopId: canonicalizeShopId(v.shopId as string), shopDomain: (v.shopDomain as string).toLowerCase() };
}

function snapshot(attempt: any, order: any, cycle: any) { return { attempt: { id: attempt.id, status: attempt.status, orderAmount: attempt.orderAmount?.toString?.() ?? null, orderCurrencyCode: attempt.orderCurrencyCode, attemptedAt: attempt.attemptedAt?.toISOString?.() ?? null, completedAt: attempt.completedAt?.toISOString?.() ?? null, cycleOriginTime: attempt.cycleOriginTime?.toISOString?.() ?? null, reconciliationStatus: attempt.reconciliationStatus }, order: { id: order.id, amount: order.amount?.toString?.() ?? null, currencyCode: order.currencyCode, status: order.status, processedAt: order.processedAt?.toISOString?.() ?? null }, cycle: cycle ? { id: cycle.id, status: cycle.status } : null }; }
function hash(input: AdministrativeBillingReconciliationInput) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }

export class AdministrativeBillingReconciliationService {
  constructor(private readonly prisma: PrismaClient | any = new PrismaClient()) {}
  async execute(raw: unknown) {
    const input = validateAdministrativeBillingReconciliation(raw), payloadHash = hash(input);
    for (let transactionAttempt = 1; transactionAttempt <= 3; transactionAttempt += 1) {
      try {
        return await this.executeTransaction(input, payloadHash);
      } catch (error) {
        const isRetryableConcurrencyError = error instanceof Prisma.PrismaClientKnownRequestError
          && (error.code === "P2002" || error.code === "P2034");
        if (!isRetryableConcurrencyError || transactionAttempt === 3) throw error;
      }
    }
    throw new AdministrativeReconciliationError(409, "reconciliation_concurrency_conflict");
  }

  private async executeTransaction(input: AdministrativeBillingReconciliationInput, payloadHash: string) {
    let prismaStage: AdministrativeReconciliationPrismaStage = "transaction_initialization";
    return this.prisma.$transaction(async (tx: any) => {
      prismaStage = "shop_lookup";
      const shop = await tx.shop.findUnique({ where: { domain: input.shopDomain }, select: { id: true, isActive: true, shopifyShopId: true } });
      if (!shop || !shop.isActive || !shop.shopifyShopId || canonicalizeShopId(shop.shopifyShopId) !== input.shopId) throw new AdministrativeReconciliationError(409, "shop_identity_mismatch");
      prismaStage = "subscription_lookup";
      const subscription = await tx.subscription.findUnique({ where: { shopId_shopifyContractId: { shopId: shop.id, shopifyContractId: input.subscriptionContractId } }, select: { id: true, shopId: true } });
      if (!subscription) throw new AdministrativeReconciliationError(409, "subscription_identity_mismatch");
      prismaStage = "billing_attempt_lookup";
      const attempts = await tx.subscriptionBillingAttempt.findMany({ where: { shopId: shop.id, shopifyBillingAttemptId: input.subscriptionBillingAttemptId } });
      if (attempts.length !== 1 || attempts[0].subscriptionId !== subscription.id || attempts[0].shopifyContractId !== input.subscriptionContractId || (attempts[0].shopifyOrderId && attempts[0].shopifyOrderId !== input.shopifyOrderId)) throw new AdministrativeReconciliationError(409, "billing_attempt_identity_mismatch");
      prismaStage = "subscription_order_lookup";
      const orders = await tx.subscriptionOrder.findMany({ where: { subscriptionId: subscription.id, shopifyOrderId: input.shopifyOrderId } });
      if (orders.length !== 1) throw new AdministrativeReconciliationError(409, "order_identity_mismatch");
      const cycleAt = new Date(input.cycleOriginTime), attempt = attempts[0], order = orders[0];
      prismaStage = "billing_retry_cycle_lookup";
      const cycle = await tx.billingRetryCycle.findUnique({ where: { subscriptionId_billingCycleAt: { subscriptionId: subscription.id, billingCycleAt: cycleAt } } });
      if (cycle && cycle.status === "succeeded" && attempt.cycleOriginTime && attempt.cycleOriginTime.getTime() !== cycleAt.getTime()) throw new AdministrativeReconciliationError(409, "cycle_identity_mismatch");
      prismaStage = "reconciliation_audit_lookup";
      const existingAudit = await tx.billingReconciliationAudit.findUnique({ where: { billingAttemptId: attempt.id } });
      if (existingAudit) {
        if (existingAudit.payloadHash !== payloadHash) throw new AdministrativeReconciliationError(409, "reconciliation_payload_conflict");
        return { status: "already_reconciled", dryRun: input.dryRun, before: existingAudit.before, after: existingAudit.after };
      }
      if (!input.dryRun && attempt.reconciliationStatus !== "pending") throw new AdministrativeReconciliationError(409, "billing_attempt_not_pending");
      const before = snapshot(attempt, order, cycle);
      const after = { attempt: { ...before.attempt, status: "succeeded", orderAmount: input.amount, orderCurrencyCode: input.currencyCode, attemptedAt: input.attemptedAt, completedAt: input.completedAt, cycleOriginTime: input.cycleOriginTime, reconciliationStatus: "complete" }, order: { ...before.order, amount: input.amount, currencyCode: input.currencyCode, status: "PAID", processedAt: input.orderProcessedAt }, cycle: cycle ? { id: cycle.id, status: "succeeded" } : null };
      if (input.dryRun) return { status: "dry_run", dryRun: true, before, after };
      prismaStage = "billing_attempt_update";
      await tx.subscriptionBillingAttempt.update({ where: { id: attempt.id }, data: { status: "succeeded", shopifyOrderId: input.shopifyOrderId, orderAmount: input.amount, orderCurrencyCode: input.currencyCode, attemptedAt: new Date(input.attemptedAt), completedAt: new Date(input.completedAt), cycleOriginTime: cycleAt, reconciliationStatus: "complete", reconciliationError: null, reconciliationAttempts: { increment: 1 } } });
      prismaStage = "subscription_order_update";
      await tx.subscriptionOrder.update({ where: { id: order.id }, data: { amount: input.amount, currencyCode: input.currencyCode, status: "PAID", processedAt: new Date(input.orderProcessedAt) } });
      if (cycle) {
        prismaStage = "billing_retry_cycle_update";
        await tx.billingRetryCycle.update({ where: { id: cycle.id }, data: { status: "succeeded" } });
      }
      prismaStage = "reconciliation_audit_create";
      await tx.billingReconciliationAudit.create({ data: { shopId: shop.id, subscriptionId: subscription.id, billingAttemptId: attempt.id, shopifyBillingAttemptId: input.subscriptionBillingAttemptId, shopifyOrderId: input.shopifyOrderId, cycleOriginTime: cycleAt, correlationId: input.correlationId, payloadHash, before, after } });
      return { status: "reconciled", dryRun: false, before, after };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: unknown) => {
      recordAdministrativeReconciliationPrismaStage(error, prismaStage);
      throw error;
    });
  }
}
