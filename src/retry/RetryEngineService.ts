import { Prisma, PrismaClient, RetryFailureAction, RetryJobStatus, RetryKind, TeamNotificationFrequency } from "@prisma/client";
import { SubscriptionLifecycleService } from "../services/SubscriptionLifecycleService";
import { advanceBillingDate, nextRetry } from "./retry-policy";
import { RETRY_DEFAULTS } from "./retry-settings";

type Fetch = typeof fetch;
export type RetryMetrics = { found: number; claimed: number; completed: number; rescheduled: number; failed: number; skipped: number };
const TERMINAL = new Set(["paused", "cancelled", "expired", "failed"]);

export class RetryEngineService {
  constructor(private prisma = new PrismaClient(), private fetchFn: Fetch = fetch, private lifecycle = new SubscriptionLifecycleService(prisma)) {}

  async run(batchSize = 10, now = new Date()): Promise<RetryMetrics> {
    const metrics = { found: 0, claimed: 0, completed: 0, rescheduled: 0, failed: 0, skipped: 0 };
    await this.seed(now, batchSize);
    const candidates = await this.prisma.billingRetryJob.findMany({
      where: { OR: [{ status: RetryJobStatus.PENDING, scheduledAt: { lte: now } }, { status: RetryJobStatus.CLAIMED, leaseExpiresAt: { lt: now } }, { status: RetryJobStatus.UNCERTAIN, scheduledAt: { lte: now } }] },
      orderBy: { scheduledAt: "asc" }, take: batchSize, select: { id: true },
    });
    metrics.found = candidates.length;
    for (const candidate of candidates) {
      const leaseExpiresAt = new Date(now.getTime() + 45_000);
      const claimed = await this.prisma.billingRetryJob.updateMany({
        where: { id: candidate.id, OR: [{ status: RetryJobStatus.PENDING, scheduledAt: { lte: now } }, { status: RetryJobStatus.CLAIMED, leaseExpiresAt: { lt: now } }, { status: RetryJobStatus.UNCERTAIN, scheduledAt: { lte: now } }] },
        data: { status: RetryJobStatus.CLAIMED, claimedAt: now, leaseExpiresAt },
      });
      if (!claimed.count) continue;
      metrics.claimed++;
      try { await this.process(candidate.id, now, metrics); }
      catch (error) {
        metrics.failed++;
        await this.prisma.billingRetryJob.update({ where: { id: candidate.id }, data: { status: RetryJobStatus.UNCERTAIN, errorCode: "worker_error", errorMessage: this.safeError(error), scheduledAt: new Date(now.getTime() + 300_000), leaseExpiresAt: null } });
      }
    }
    return metrics;
  }

  private async seed(now: Date, take: number) {
    const due = await this.prisma.subscription.findMany({ where: { gateway: "shopify", status: { equals: "active", mode: "insensitive" }, nextBillingAt: { lte: now }, shop: { isActive: true } }, orderBy: { nextBillingAt: "asc" }, take, include: { shop: true } });
    for (const subscription of due) {
      const billingCycleAt = subscription.nextBillingAt!;
      const settings = await this.settings(subscription.shopId);
      const cycle = await this.prisma.billingRetryCycle.upsert({ where: { subscriptionId_billingCycleAt: { subscriptionId: subscription.id, billingCycleAt } }, create: { shopId: subscription.shopId, subscriptionId: subscription.id, billingCycleAt }, update: {} });
      await this.prisma.billingRetryJob.upsert({ where: { cycleId_kind_attemptNumber: { cycleId: cycle.id, kind: RetryKind.INVENTORY, attemptNumber: 0 } }, create: { shopId: subscription.shopId, subscriptionId: subscription.id, cycleId: cycle.id, kind: RetryKind.INVENTORY, attemptNumber: 0, maxRetries: settings.inventoryRetryAttempts, scheduledAt: now, idempotencyKey: `aps:${cycle.id}:inventory:0` }, update: {} });
    }
  }

  private async process(id: string, now: Date, metrics: RetryMetrics) {
    const job = await this.prisma.billingRetryJob.findUniqueOrThrow({ where: { id }, include: { cycle: true, subscription: { include: { shop: true, contractLines: { where: { isActive: true } } } } } });
    const state = String(job.subscription.status || "").toLowerCase();
    if (TERMINAL.has(state)) { await this.finish(job.id, RetryJobStatus.SKIPPED, now, { errorCode: "subscription_not_active" }); metrics.skipped++; return; }
    if (job.subscription.gateway !== "shopify" || !job.subscription.shopifyContractId) { await this.finish(job.id, RetryJobStatus.SKIPPED, now, { errorCode: "invalid_gateway" }); metrics.skipped++; return; }
    const result = await this.callApp(job.subscription.shop.domain, {
      shop: job.subscription.shop.domain, contractId: job.subscription.shopifyContractId, operation: job.kind === RetryKind.INVENTORY ? "inventory" : "charge",
      billingCycleAt: job.cycle.billingCycleAt.toISOString(), idempotencyKey: job.idempotencyKey,
      lines: job.subscription.contractLines.map(line => ({ variantId: line.shopifyVariantId, quantity: line.quantity })),
    });
    if (job.kind === RetryKind.INVENTORY && result.success && result.available === true) {
      await this.prisma.$transaction(async tx => {
        await tx.billingRetryJob.update({ where: { id }, data: { status: RetryJobStatus.SUCCEEDED, completedAt: now, leaseExpiresAt: null, inventoryResult: result as Prisma.InputJsonValue } });
        await tx.billingRetryJob.upsert({ where: { cycleId_kind_attemptNumber: { cycleId: job.cycleId, kind: RetryKind.PAYMENT, attemptNumber: 0 } }, create: { shopId: job.shopId, subscriptionId: job.subscriptionId, cycleId: job.cycleId, kind: RetryKind.PAYMENT, attemptNumber: 0, maxRetries: (await this.settings(job.shopId)).paymentRetryAttempts, scheduledAt: now, idempotencyKey: `aps:${job.cycleId}:payment:0` }, update: {} });
      }); metrics.completed++; return;
    }
    if (job.kind === RetryKind.PAYMENT && result.success && result.status === "succeeded") {
      await this.prisma.$transaction(async tx => {
        await tx.billingRetryJob.update({ where: { id }, data: { status: RetryJobStatus.SUCCEEDED, completedAt: now, leaseExpiresAt: null, externalAttemptId: result.billingAttemptId as string | undefined } });
        await tx.billingRetryCycle.update({ where: { id: job.cycleId }, data: { status: "succeeded" } });
        await tx.subscription.update({ where: { id: job.subscriptionId }, data: { lastPaymentStatus: "succeeded", nextBillingAt: advanceBillingDate(job.cycle.billingCycleAt, job.subscription.billingInterval, job.subscription.billingIntervalCount) } });
      }); metrics.completed++; return;
    }
    if (result.uncertain || (job.kind === RetryKind.PAYMENT && result.status === "pending")) {
      await this.prisma.billingRetryJob.update({ where: { id }, data: { status: RetryJobStatus.UNCERTAIN, scheduledAt: new Date(now.getTime() + 300_000), leaseExpiresAt: null, externalAttemptId: result.billingAttemptId as string | undefined, errorCode: "external_result_uncertain" } }); metrics.rescheduled++; return;
    }
    const settings = await this.settings(job.shopId);
    const days = job.kind === RetryKind.PAYMENT ? settings.paymentRetryDays : settings.inventoryRetryDays;
    const action = job.kind === RetryKind.PAYMENT ? settings.paymentFailureAction : settings.inventoryFailureAction;
    const decision = nextRetry(job.attemptNumber, job.maxRetries, days, now);
    await this.finish(job.id, decision.exhausted ? RetryJobStatus.EXHAUSTED : RetryJobStatus.FAILED, now, { errorCode: String(result.errorCode || (job.kind === RetryKind.INVENTORY ? "inventory_unavailable" : "payment_failed")), errorMessage: String(result.errorMessage || "Operation failed").slice(0, 250), inventoryResult: job.kind === RetryKind.INVENTORY ? result as Prisma.InputJsonValue : undefined, finalAction: decision.exhausted ? action : undefined });
    if (decision.exhausted) { await this.finalAction(job, action, settings.teamNotificationFrequency, now); metrics.failed++; }
    else { await this.prisma.billingRetryJob.create({ data: { shopId: job.shopId, subscriptionId: job.subscriptionId, cycleId: job.cycleId, kind: job.kind, attemptNumber: decision.nextAttempt!, maxRetries: job.maxRetries, scheduledAt: decision.scheduledAt!, idempotencyKey: `aps:${job.cycleId}:${job.kind.toLowerCase()}:${decision.nextAttempt}` } }); metrics.rescheduled++; }
  }

  private async finalAction(job: any, action: RetryFailureAction, frequency: TeamNotificationFrequency, now: Date) {
    if (action === RetryFailureAction.PAUSE_AND_NOTIFY) await this.lifecycle.execute(job.subscriptionId, "pause", `retry-final:${job.cycleId}:pause`, "PARTNER");
    else if (action === RetryFailureAction.CANCEL_AND_NOTIFY) await this.lifecycle.execute(job.subscriptionId, "cancel", `retry-final:${job.cycleId}:cancel`, "PARTNER");
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.billingRetryCycle.updateMany({ where: { id: job.cycleId, finalActionAt: null }, data: { status: action === RetryFailureAction.SKIP_AND_NOTIFY ? "skipped" : "finalized", finalAction: action, finalActionAt: now, ...(action === RetryFailureAction.SKIP_AND_NOTIFY ? { nextBillingAdvanced: true } : {}) } });
      if (!claimed.count) return;
      if (action === RetryFailureAction.PAUSE_AND_NOTIFY) await tx.subscription.update({ where: { id: job.subscriptionId }, data: { status: "paused" } });
      if (action === RetryFailureAction.CANCEL_AND_NOTIFY) await tx.subscription.update({ where: { id: job.subscriptionId }, data: { status: "cancelled" } });
      if (action === RetryFailureAction.SKIP_AND_NOTIFY) await tx.subscription.update({ where: { id: job.subscriptionId }, data: { nextBillingAt: advanceBillingDate(job.cycle.billingCycleAt, job.subscription.billingInterval, job.subscription.billingIntervalCount) } });
      if (frequency !== TeamNotificationFrequency.NEVER) await tx.notificationOutbox.create({ data: { shopId: job.shopId, cycleId: job.cycleId, idempotencyKey: `retry-notification:${job.cycleId}:${action}`, frequency, eventType: "retry_exhausted", payload: { subscriptionId: job.subscriptionId, kind: job.kind, action }, availableAt: this.notificationTime(frequency, now) } });
      await tx.subscriptionStatusHistory.create({ data: { subscriptionId: job.subscriptionId, previousStatus: job.subscription.status, newStatus: action === RetryFailureAction.CANCEL_AND_NOTIFY ? "cancelled" : action === RetryFailureAction.PAUSE_AND_NOTIFY ? "paused" : job.subscription.status, previousPaymentStatus: job.subscription.lastPaymentStatus, newPaymentStatus: job.subscription.lastPaymentStatus, source: "retry_engine", sourceEventId: `retry-final:${job.cycleId}`, actor: "PARTNER", reason: `${job.kind}:${action}` } });
    });
  }

  private notificationTime(frequency: TeamNotificationFrequency, now: Date) { const date = new Date(now); if (frequency === TeamNotificationFrequency.DAILY_SUMMARY) date.setUTCHours(24, 0, 0, 0); else if (frequency === TeamNotificationFrequency.WEEKLY_SUMMARY) { date.setUTCDate(date.getUTCDate() + ((8 - date.getUTCDay()) % 7 || 7)); date.setUTCHours(0, 0, 0, 0); } return date; }
  private settings(shopId: string) { return this.prisma.billingRetrySettings.findUnique({ where: { shopId } }).then(value => value ?? { shopId, ...RETRY_DEFAULTS, createdAt: new Date(0), updatedAt: new Date(0) }); }
  private finish(id: string, status: RetryJobStatus, now: Date, data: Record<string, unknown>) { return this.prisma.billingRetryJob.update({ where: { id }, data: { ...data, status, completedAt: now, leaseExpiresAt: null } }); }
  private safeError(error: unknown) { return (error instanceof Error ? error.message : "Unknown worker error").slice(0, 250); }
  private async callApp(shop: string, body: Record<string, unknown>) {
    const base = process.env.SHOPIFY_APP_URL?.replace(/\/$/, ""), key = process.env.SHOPIFY_APP_API_KEY;
    if (!base || !key) throw new Error("shopify_app_not_configured");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000);
    try { const response = await this.fetchFn(`${base}/api/shopify/retry-operation`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "idempotency-key": String(body.idempotencyKey) }, body: JSON.stringify(body), signal: controller.signal }); const value = await response.json() as Record<string, unknown>; return response.ok ? value : { success: false, errorCode: value.error || `http_${response.status}`, errorMessage: "Shopify operation failed", uncertain: response.status >= 500 }; }
    catch (error) { return { success: false, uncertain: true, errorCode: controller.signal.aborted ? "timeout" : "network_error", errorMessage: this.safeError(error) }; }
    finally { clearTimeout(timer); }
  }
}
