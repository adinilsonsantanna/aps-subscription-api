import { timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { Request, Response } from "express";
import { NotificationOutboxService } from "../notifications/NotificationOutboxService";
import { NotificationSettingsService } from "../notifications/NotificationSettingsService";
import { ResendDomainService } from "../notifications/ResendDomainService";
const prisma = new PrismaClient();
export class NotificationController {
  constructor(private settings = new NotificationSettingsService(), private domains = new ResendDomainService(), private outbox = new NotificationOutboxService(), private db: any = prisma) {}
  getSettings(req: Request, res: Response) { return this.reply(res, () => this.settings.get(String(req.params.shop))); }
  saveSettings(req: Request, res: Response) { return this.reply(res, () => this.settings.save(String(req.params.shop), req.body)); }
  getDomains(req: Request, res: Response) { return this.reply(res, () => this.domains.get(String(req.params.shop))); }
  setupDomain(req: Request, res: Response) { return this.reply(res, () => this.domains.setup(String(req.params.shop))); }
  verifyDomain(req: Request, res: Response) { return this.reply(res, () => this.domains.verify(String(req.params.shop))); }
  refreshDomain(req: Request, res: Response) { return this.reply(res, () => this.domains.refresh(String(req.params.shop))); }
  async test(req: Request, res: Response) { try { const settings: any = await this.settings.get(String(req.params.shop)); if (!settings?.activeSendingDomain?.sendingVerified) return res.status(409).json({ success: false, error: "sender_not_verified" }); const recipient = settings.teamEmails?.[0]; if (!recipient) return res.status(422).json({ success: false, error: "missing_recipient" }); const now = new Date(), claim = await this.db.notificationSettings.updateMany({ where: { shopId: settings.shopId, OR: [{ lastTestAt: null }, { lastTestAt: { lt: new Date(now.getTime() - 60_000) } }] }, data: { lastTestAt: now } }); if (!claim.count) return res.status(429).json({ success: false, error: "rate_limited" }); const job = await this.outbox.enqueue({ shopId: settings.shopId, idempotencyKey: `notification-test:${settings.shopId}:${Math.floor(now.getTime() / 60_000)}`, eventType: "team_summary", payload: { shop: String(req.params.shop), status: "Configuração de envio validada" }, recipientType: "team", recipientEmail: recipient }); await this.outbox.run(1); const current = await this.db.notificationOutbox.findUnique({ where: { id: job.id }, select: { status: true } }); return res.json({ success: current?.status === "sent", status: current?.status }); } catch (error) { return this.error(res, error); } }
  async cron(req: Request, res: Response) { const expected = process.env.CRON_SECRET || "", received = String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(received) || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) return res.status(401).json({ error: "unauthorized" }); return this.reply(res, () => this.outbox.run(Math.min(50, Math.max(1, Number(req.query.limit) || 20)))); }
  private async reply(res: Response, fn: () => Promise<any>) { try { return res.json({ success: true, data: await fn() }); } catch (error) { return this.error(res, error); } }
  private error(res: Response, error: any) { return res.status(error?.statusCode || 400).json({ success: false, error: String(error?.message || "notification_error") }); }
}
