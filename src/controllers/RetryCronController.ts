import { timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { RetryEngineService } from "../retry/RetryEngineService";
import { NotificationOutboxService } from "../notifications/NotificationOutboxService";
import { ResendDomainService } from "../notifications/ResendDomainService";
import { NotificationEventService } from "../notifications/NotificationEventService";
export class RetryCronController {
  constructor(private engine = new RetryEngineService(), private notifications = new NotificationOutboxService(), private domains = new ResendDomainService(), private events = new NotificationEventService()) {}
  async run(req: Request, res: Response) {
    const expected = process.env.CRON_SECRET || "", received = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const valid = expected && Buffer.byteLength(expected) === Buffer.byteLength(received) && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!valid) return res.status(401).json({ error: "unauthorized" });
    const retryLimit = Math.min(25, Math.max(1, Number(req.query.retryLimit) || Number(req.query.limit) || 10));
    const notificationLimit = Math.min(50, Math.max(1, Number(req.query.notificationLimit) || 20));
    const cleanupLimit = Math.min(25, Math.max(1, Number(req.query.cleanupLimit) || 10));
    const drainNotifications = async () => ({ summaries: await this.events.materializeSummaries(notificationLimit), deliveries: await this.notifications.run(notificationLimit) });
    const [retry, notifications, credentialCleanup] = await Promise.allSettled([this.engine.run(retryLimit), drainNotifications(), this.domains.runCredentialCleanup(cleanupLimit)]);
    const serialize = (result: PromiseSettledResult<unknown>) => result.status === "fulfilled" ? { success: true, metrics: result.value } : { success: false, error: result.reason instanceof Error ? result.reason.message.slice(0, 250) : "cron_worker_failed" };
    const body = { success: retry.status === "fulfilled" && notifications.status === "fulfilled" && credentialCleanup.status === "fulfilled", retry: serialize(retry), notifications: serialize(notifications), credentialCleanup: serialize(credentialCleanup) };
    return res.status(body.success ? 200 : 500).json(body);
  }
}
