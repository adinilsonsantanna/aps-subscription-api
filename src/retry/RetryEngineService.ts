import { Prisma, PrismaClient, RetryFailureAction, RetryJobStatus, RetryKind, TeamNotificationFrequency } from "@prisma/client";
import { SubscriptionLifecycleService } from "../services/SubscriptionLifecycleService";
import { advanceBillingDate, nextRetry } from "./retry-policy";
import { RETRY_DEFAULTS } from "./retry-settings";
import { NotificationEventService } from "../notifications/NotificationEventService";
import { canonicalBillingSourceKey } from "../notifications/billing-notification-identity";

type Fetch = typeof fetch;
export const billingRetryJobKey = (shopId: string, cycleId: string, kind: RetryKind, attemptNumber: number | null) => {
  if (attemptNumber === null) throw new Error("retry_attempt_number_unavailable");
  return `aps:${shopId}:${cycleId}:${String(kind).toLowerCase()}:${attemptNumber}`;
};
type AppResult = Record<string, unknown> & { success?: boolean; uncertain?: boolean; status?: string; available?: boolean; errorCode?: string | null; errorMessage?: string | null; billingAttemptId?: string | null; orderId?: string | null; amount?: string | null; currencyCode?: string | null };
export type RetryMetrics = { found: number; claimed: number; completed: number; rescheduled: number; failed: number; skipped: number };
const TERMINAL = new Set(["paused", "cancelled", "expired", "failed"]);
const RECONCILE_INTERVAL_MS = 300_000, RECONCILE_WINDOW_MS = 3_600_000, LEASE_MS = 45_000;

export class RetryEngineService {
  constructor(private prisma: PrismaClient | any = new PrismaClient(), private fetchFn: Fetch = fetch, private lifecycle: SubscriptionLifecycleService | any = new SubscriptionLifecycleService(prisma), private notificationEvents: NotificationEventService = new NotificationEventService(prisma)) {}

  async run(batchSize = 10, now = new Date()): Promise<RetryMetrics> {
    const metrics = { found: 0, claimed: 0, completed: 0, rescheduled: 0, failed: 0, skipped: 0 };
    await this.recoverFinalActions(now, batchSize);
    await this.seed(now, batchSize);
    const candidates = await this.prisma.billingRetryJob.findMany({ where: { OR: [{ status: RetryJobStatus.PENDING, scheduledAt: { lte: now } }, { status: RetryJobStatus.CLAIMED, leaseExpiresAt: { lt: now } }, { status: RetryJobStatus.UNCERTAIN, scheduledAt: { lte: now } }] }, orderBy: { scheduledAt: "asc" }, take: batchSize, select: { id: true } });
    metrics.found = candidates.length;
    for (const candidate of candidates) {
      const claimed = await this.prisma.billingRetryJob.updateMany({ where: { id: candidate.id, OR: [{ status: RetryJobStatus.PENDING, scheduledAt: { lte: now } }, { status: RetryJobStatus.CLAIMED, leaseExpiresAt: { lt: now } }, { status: RetryJobStatus.UNCERTAIN, scheduledAt: { lte: now } }] }, data: { status: RetryJobStatus.CLAIMED, claimedAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) } });
      if (!claimed.count) continue;
      metrics.claimed++;
      try { await this.processClaimedJob(candidate.id, now, metrics); }
      catch (error) { await this.handleWorkerException(candidate.id, error, now, metrics); }
    }
    await this.recoverFinalActions(now, batchSize);
    return metrics;
  }

  async processClaimedJob(id: string, now: Date, metrics: RetryMetrics) {
    const job = await this.prisma.billingRetryJob.findUniqueOrThrow({ where: { id }, include: { cycle: true, subscription: { include: { shop: true, contractLines: { where: { isActive: true } } } } } });
    const state = String(job.subscription.status || "").toLowerCase();
    if (TERMINAL.has(state)) { await this.finish(job.id, RetryJobStatus.SKIPPED, now, { errorCode: "subscription_not_active" }); metrics.skipped++; return; }
    if (job.subscription.gateway !== "shopify" || !job.subscription.shopifyContractId) { await this.finish(job.id, RetryJobStatus.SKIPPED, now, { errorCode: "invalid_gateway" }); metrics.skipped++; return; }
    const operation = job.kind === RetryKind.INVENTORY ? "inventory" : job.firstUncertainAt ? "reconcile" : "charge";
    const result = await this.callApp({ shop: job.subscription.shop.domain, contractId: job.subscription.shopifyContractId, operation, billingCycleAt: job.cycle.billingCycleAt.toISOString(), idempotencyKey: job.idempotencyKey, billingAttemptId: job.externalAttemptId, lines: job.subscription.contractLines.map((line: any) => ({ variantId: line.shopifyVariantId, quantity: line.quantity })) });
    if (job.kind === RetryKind.INVENTORY && result.success && result.available === true) { await this.inventorySucceeded(job, result, now); metrics.completed++; return; }
    if (job.kind === RetryKind.PAYMENT && result.success && result.status === "succeeded") { await this.paymentSucceeded(job, result, now); metrics.completed++; return; }
    if (result.uncertain || (job.kind === RetryKind.PAYMENT && result.status === "pending")) { await this.handleUncertain(job, result, now, metrics); return; }
    await this.failOrReschedule(job, result, now, metrics);
  }

  private async seed(now: Date, take: number) {
    const due = await this.prisma.subscription.findMany({ where: { gateway: "shopify", status: { equals: "active", mode: "insensitive" }, nextBillingAt: { lte: now }, shop: { isActive: true } }, orderBy: { nextBillingAt: "asc" }, take, include: { shop: true } });
    for (const subscription of due) { const settings = await this.settings(subscription.shopId); const cycle = await this.prisma.billingRetryCycle.upsert({ where: { subscriptionId_billingCycleAt: { subscriptionId: subscription.id, billingCycleAt: subscription.nextBillingAt } }, create: { shopId: subscription.shopId, subscriptionId: subscription.id, billingCycleAt: subscription.nextBillingAt }, update: {} }); await this.prisma.billingRetryJob.upsert({ where: { cycleId_kind_attemptNumber: { cycleId: cycle.id, kind: RetryKind.INVENTORY, attemptNumber: 0 } }, create: { shopId: subscription.shopId, subscriptionId: subscription.id, cycleId: cycle.id, kind: RetryKind.INVENTORY, attemptNumber: 0, maxRetries: settings.inventoryRetryAttempts, scheduledAt: now, idempotencyKey: billingRetryJobKey(subscription.shopId, cycle.id, RetryKind.INVENTORY, 0) }, update: {} }); }
  }

  private async inventorySucceeded(job: any, result: AppResult, now: Date) {
    const settings = await this.settings(job.shopId);
    await this.prisma.$transaction(async (tx: any) => { await tx.billingRetryJob.update({ where: { id: job.id }, data: { status: RetryJobStatus.SUCCEEDED, completedAt: now, leaseExpiresAt: null, inventoryResult: result as Prisma.InputJsonValue } }); await tx.billingRetryJob.upsert({ where: { cycleId_kind_attemptNumber: { cycleId: job.cycleId, kind: RetryKind.PAYMENT, attemptNumber: 0 } }, create: { shopId: job.shopId, subscriptionId: job.subscriptionId, cycleId: job.cycleId, kind: RetryKind.PAYMENT, attemptNumber: 0, maxRetries: settings.paymentRetryAttempts, scheduledAt: now, idempotencyKey: billingRetryJobKey(job.shopId, job.cycleId, RetryKind.PAYMENT, 0) }, update: {} }); });
  }

  private async paymentSucceeded(job: any, result: AppResult, now: Date) {
    if (!result.billingAttemptId || !result.orderId || result.amount === null || !result.currencyCode) throw new Error("successful_payment_missing_external_ids");
    await this.prisma.$transaction(async (tx: any) => {
      await tx.subscriptionBillingAttempt.upsert({ where: { shopId_idempotencyKey: { shopId: job.shopId, idempotencyKey: job.idempotencyKey } }, create: { shopId: job.shopId, subscriptionId: job.subscriptionId, shopifyContractId: job.subscription.shopifyContractId, shopifyBillingAttemptId: result.billingAttemptId, idempotencyKey: job.idempotencyKey, status: "succeeded", shopifyOrderId: result.orderId, attemptedAt: now }, update: { shopifyBillingAttemptId: result.billingAttemptId, status: "succeeded", shopifyOrderId: result.orderId, errorCode: null, errorMessage: null, attemptedAt: now } });
      await tx.subscriptionOrder.upsert({ where: { shopifyOrderKey: `${job.shopId}:${result.orderId}` }, create: { subscriptionId: job.subscriptionId, shopifyOrderId: result.orderId, shopifyOrderKey: `${job.shopId}:${result.orderId}`, gatewayOrderId: result.billingAttemptId, amount: result.amount, currencyCode: result.currencyCode, status: "PAID", processedAt: now }, update: { shopifyOrderId: result.orderId, gatewayOrderId: result.billingAttemptId, amount: result.amount, currencyCode: result.currencyCode, status: "PAID", processedAt: now } });
      await tx.billingRetryJob.update({ where: { id: job.id }, data: { status: RetryJobStatus.SUCCEEDED, completedAt: now, leaseExpiresAt: null, externalAttemptId: result.billingAttemptId, externalOrderId: result.orderId, lastReconciledAt: job.firstUncertainAt ? now : undefined } });
      const completed = await tx.billingRetryCycle.updateMany({ where: { id: job.cycleId, status: { not: "succeeded" } }, data: { status: "succeeded" } });
      if (completed.count) await tx.subscription.update({ where: { id: job.subscriptionId }, data: { lastPaymentStatus: "succeeded", nextBillingAt: advanceBillingDate(job.cycle.billingCycleAt, job.subscription.billingInterval, job.subscription.billingIntervalCount) } });
    });
    await this.notificationEvents.emit({ shopId: job.shopId, eventType: "renewal_succeeded", sourceKey: canonicalBillingSourceKey({ shopifyBillingAttemptId: result.billingAttemptId, idempotencyKey: job.idempotencyKey, shopifyContractId: job.subscription.shopifyContractId, billingCycleAt: job.cycle.billingCycleAt }), payload: { subscriptionId: job.subscriptionId, orderId: result.orderId, amount: result.amount, currency: result.currencyCode }, customerEmail: job.subscription.shopifyCustomerEmail, occurredAt: now });
  }

  private async handleUncertain(job: any, result: AppResult, now: Date, metrics: RetryMetrics) {
    const count = job.reconciliationCount + 1, deadline = job.reconciliationDeadlineAt ?? new Date((job.firstUncertainAt ?? now).getTime() + RECONCILE_WINDOW_MS);
    if (count >= job.maxReconciliations || now >= deadline) { const settings = await this.settings(job.shopId); const action = job.kind === RetryKind.INVENTORY ? settings.inventoryFailureAction : settings.paymentFailureAction; await this.prisma.$transaction(async (tx: any) => { await tx.billingRetryJob.update({ where: { id: job.id }, data: { status: RetryJobStatus.EXHAUSTED, completedAt: now, leaseExpiresAt: null, reconciliationCount: count, firstUncertainAt: job.firstUncertainAt ?? now, lastReconciledAt: now, reconciliationDeadlineAt: deadline, errorCode: "reconciliation_exhausted", errorMessage: result.errorMessage || "Shopify attempt could not be reconciled", finalAction: action } }); await tx.billingRetryCycle.updateMany({ where: { id: job.cycleId, finalActionStatus: "none" }, data: { finalAction: action, finalActionStatus: "pending", finalActionError: null } }); }); metrics.failed++; return; }
    await this.markUncertain(job.id, now, { externalAttemptId: result.billingAttemptId || job.externalAttemptId, reconciliationCount: count, firstUncertainAt: job.firstUncertainAt ?? now, lastReconciledAt: now, reconciliationDeadlineAt: deadline, errorCode: result.errorCode || "external_result_uncertain", errorMessage: result.errorMessage }); metrics.rescheduled++;
  }

  private async failOrReschedule(job: any, result: AppResult, now: Date, metrics: RetryMetrics) {
    const settings = await this.settings(job.shopId), days = job.kind === RetryKind.PAYMENT ? settings.paymentRetryDays : settings.inventoryRetryDays, action = job.kind === RetryKind.PAYMENT ? settings.paymentFailureAction : settings.inventoryFailureAction, decision = nextRetry(job.attemptNumber, job.maxRetries, days, now);
    await this.prisma.$transaction(async (tx: any) => {
      await tx.billingRetryJob.update({ where: { id: job.id }, data: { status: decision.exhausted ? RetryJobStatus.EXHAUSTED : RetryJobStatus.FAILED, completedAt: now, leaseExpiresAt: null, errorCode: result.errorCode || (job.kind === RetryKind.INVENTORY ? "inventory_unavailable" : "payment_failed"), errorMessage: String(result.errorMessage || "Operation failed").slice(0, 250), inventoryResult: job.kind === RetryKind.INVENTORY ? result as Prisma.InputJsonValue : undefined, finalAction: decision.exhausted ? action : undefined, externalAttemptId: result.billingAttemptId || undefined } });
      if (decision.exhausted) await tx.billingRetryCycle.updateMany({ where: { id: job.cycleId, finalActionStatus: "none" }, data: { finalAction: action, finalActionStatus: "pending" } });
      else await tx.billingRetryJob.create({ data: { shopId: job.shopId, subscriptionId: job.subscriptionId, cycleId: job.cycleId, kind: job.kind, attemptNumber: decision.nextAttempt, maxRetries: job.maxRetries, scheduledAt: decision.scheduledAt, idempotencyKey: billingRetryJobKey(job.shopId, job.cycleId, job.kind, decision.nextAttempt) } });
    });
    const failureEvent = job.kind === RetryKind.INVENTORY ? "inventory_insufficient" : "payment_failed";
    await this.notificationEvents.emit({ shopId: job.shopId, eventType: failureEvent, sourceKey: canonicalBillingSourceKey({ shopifyBillingAttemptId: result.billingAttemptId || job.externalAttemptId, idempotencyKey: job.idempotencyKey, shopifyContractId: job.subscription.shopifyContractId, billingCycleAt: job.cycle.billingCycleAt }), payload: { subscriptionId: job.subscriptionId, attemptNumber: job.attemptNumber, errorCode: result.errorCode }, customerEmail: job.subscription.shopifyCustomerEmail, occurredAt: now });
    if (!decision.exhausted) await this.notificationEvents.emit({ shopId: job.shopId, eventType: job.kind === RetryKind.INVENTORY ? "inventory_retry_scheduled" : "retry_scheduled", sourceKey: `${job.idempotencyKey}:next:${decision.nextAttempt}`, payload: { subscriptionId: job.subscriptionId, attemptNumber: decision.nextAttempt, scheduledAt: decision.scheduledAt }, customerEmail: job.subscription.shopifyCustomerEmail, occurredAt: now });
    if (decision.exhausted) metrics.failed++; else metrics.rescheduled++;
  }

  private async recoverFinalActions(now: Date, take: number) {
    const cycles = await this.prisma.billingRetryCycle.findMany({ where: { finalAction: { not: null }, OR: [{ finalActionStatus: "pending" }, { finalActionStatus: "processing", finalActionLeaseExpiresAt: { lt: now } }] }, take, include: { subscription: true } });
    for (const cycle of cycles) {
      const claimed = await this.prisma.billingRetryCycle.updateMany({ where: { id: cycle.id, OR: [{ finalActionStatus: "pending" }, { finalActionStatus: "processing", finalActionLeaseExpiresAt: { lt: now } }] }, data: { finalActionStatus: "processing", finalActionClaimedAt: now, finalActionLeaseExpiresAt: new Date(now.getTime() + LEASE_MS) } });
      if (!claimed.count) continue;
      try { await this.executeFinalAction(cycle, now); } catch (error) { await this.prisma.billingRetryCycle.update({ where: { id: cycle.id }, data: { finalActionError: this.safeError(error) } }); }
    }
  }

  private async executeFinalAction(cycle: any, now: Date) {
    const action = cycle.finalAction as RetryFailureAction;
    const current = String(cycle.subscription.status || "").toLowerCase();
    const immutableTerminal = ["cancelled", "expired", "failed"].includes(current);
    if (!immutableTerminal && action === RetryFailureAction.PAUSE_AND_NOTIFY && current !== "paused") await this.lifecycle.execute(cycle.subscriptionId, "pause", `retry-final:${cycle.id}:pause`, "PARTNER");
    if (!immutableTerminal && action === RetryFailureAction.CANCEL_AND_NOTIFY) await this.lifecycle.execute(cycle.subscriptionId, "cancel", `retry-final:${cycle.id}:cancel`, "PARTNER");
    const settings = await this.settings(cycle.shopId);
    await this.prisma.$transaction(async (tx: any) => {
      if (action === RetryFailureAction.PAUSE_AND_NOTIFY) await tx.subscription.updateMany({ where: { id: cycle.subscriptionId, status: { notIn: ["cancelled", "expired", "failed"] } }, data: { status: "paused" } });
      if (!immutableTerminal && action === RetryFailureAction.CANCEL_AND_NOTIFY) await tx.subscription.update({ where: { id: cycle.subscriptionId }, data: { status: "cancelled" } });
      if (action === RetryFailureAction.SKIP_AND_NOTIFY && !cycle.nextBillingAdvanced) await tx.subscription.update({ where: { id: cycle.subscriptionId }, data: { nextBillingAt: advanceBillingDate(cycle.billingCycleAt, cycle.subscription.billingInterval, cycle.subscription.billingIntervalCount) } });
      await tx.subscriptionStatusHistory.upsert({ where: { source_sourceEventId: { source: "retry_engine", sourceEventId: `retry-final:${cycle.id}` } }, create: { subscriptionId: cycle.subscriptionId, previousStatus: cycle.subscription.status, newStatus: action === RetryFailureAction.CANCEL_AND_NOTIFY ? "cancelled" : action === RetryFailureAction.PAUSE_AND_NOTIFY ? "paused" : cycle.subscription.status, source: "retry_engine", sourceEventId: `retry-final:${cycle.id}`, actor: "PARTNER", reason: action }, update: {} });
      await tx.billingRetryCycle.update({ where: { id: cycle.id }, data: { status: action === RetryFailureAction.SKIP_AND_NOTIFY ? "skipped" : "finalized", finalActionStatus: "succeeded", finalActionAt: now, finalActionLeaseExpiresAt: null, finalActionError: null, nextBillingAdvanced: action === RetryFailureAction.SKIP_AND_NOTIFY ? true : cycle.nextBillingAdvanced } });
    });
    if (action === RetryFailureAction.PAUSE_AND_NOTIFY) await this.notificationEvents.emit({ shopId: cycle.shopId, eventType: "subscription_paused", sourceKey: `retry-final:${cycle.id}:pause`, payload: { subscriptionId: cycle.subscriptionId }, customerEmail: cycle.subscription.shopifyCustomerEmail, occurredAt: now });
    if (action === RetryFailureAction.CANCEL_AND_NOTIFY) await this.notificationEvents.emit({ shopId: cycle.shopId, eventType: "subscription_cancelled", sourceKey: `retry-final:${cycle.id}:cancel`, payload: { subscriptionId: cycle.subscriptionId }, customerEmail: cycle.subscription.shopifyCustomerEmail, occurredAt: now });
  }

  private settings(shopId: string) { return this.prisma.billingRetrySettings.findUnique({ where: { shopId } }).then((value: any) => value ?? { shopId, ...RETRY_DEFAULTS, createdAt: new Date(0), updatedAt: new Date(0) }); }
  private finish(id: string, status: RetryJobStatus, now: Date, data: Record<string, unknown>) { return this.prisma.billingRetryJob.update({ where: { id }, data: { ...data, status, completedAt: now, leaseExpiresAt: null } }); }
  private markUncertain(id: string, now: Date, data: Record<string, unknown>) { return this.prisma.billingRetryJob.update({ where: { id }, data: { ...data, status: RetryJobStatus.UNCERTAIN, scheduledAt: new Date(now.getTime() + RECONCILE_INTERVAL_MS), leaseExpiresAt: null } }); }
  private async handleWorkerException(id: string, error: unknown, now: Date, metrics: RetryMetrics) { const job = await this.prisma.billingRetryJob.findUniqueOrThrow({ where: { id }, include: { cycle: true, subscription: { include: { shop: true, contractLines: { where: { isActive: true } } } } } }); await this.handleUncertain(job, { success: false, uncertain: true, errorCode: "worker_error", errorMessage: this.safeError(error) }, now, metrics); }
  private safeError(error: unknown) { return (error instanceof Error ? error.message : "Unknown worker error").slice(0, 250); }
  private async callApp(body: Record<string, unknown>): Promise<AppResult> { const base = process.env.SHOPIFY_APP_URL?.replace(/\/$/, ""), key = process.env.SHOPIFY_APP_API_KEY; if (!base || !key) throw new Error("shopify_app_not_configured"); const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000); try { const response = await this.fetchFn(`${base}/api/shopify/retry-operation`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "idempotency-key": String(body.idempotencyKey) }, body: JSON.stringify(body), signal: controller.signal }); const value = await response.json() as AppResult; return response.ok ? value : { ...value, success: false, errorCode: value.errorCode || `http_${response.status}`, errorMessage: value.errorMessage || "Shopify operation failed", uncertain: value.uncertain ?? response.status >= 500 }; } catch (error) { return { success: false, uncertain: true, errorCode: controller.signal.aborted ? "timeout" : "network_error", errorMessage: this.safeError(error) }; } finally { clearTimeout(timer); } }
}
