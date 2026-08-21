import { timingSafeEqual } from "node:crypto";
import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { NotificationSettingsService } from "../notifications/NotificationSettingsService";
import { ResendDomainService } from "../notifications/ResendDomainService";
import { NotificationOutboxService } from "../notifications/NotificationOutboxService";
const tests = new Map<string, number>();
const prisma = new PrismaClient();
export class NotificationController {
  constructor(private settings = new NotificationSettingsService(), private domains = new ResendDomainService(), private outbox = new NotificationOutboxService()) {}
  getSettings(req: Request, res: Response) { return this.reply(res, () => this.settings.get(String(req.params.shop))); }
  saveSettings(req: Request, res: Response) { return this.reply(res, () => this.settings.save(String(req.params.shop), req.body)); }
  getDomains(req: Request, res: Response) { return this.reply(res, () => this.domains.get(String(req.params.shop))); }
  setupDomain(req: Request, res: Response) { return this.reply(res, () => this.domains.setup(String(req.params.shop))); }
  verifyDomain(req: Request, res: Response) { return this.reply(res, () => this.domains.verify(String(req.params.shop))); }
  refreshDomain(req: Request, res: Response) { return this.reply(res, () => this.domains.refresh(String(req.params.shop))); }
  async test(req: Request, res: Response) { try { const settings: any = await this.settings.get(req.params.shop); if (!settings?.activeSendingDomain?.sendingVerified) return res.status(409).json({ success: false, error: "sender_not_verified" }); const last = tests.get(settings.shopId) || 0; if (Date.now() - last < 60_000) return res.status(429).json({ success: false, error: "rate_limited" }); const recipient = settings.teamEmails?.[0]; if (!recipient) return res.status(422).json({ success: false, error: "missing_recipient" }); tests.set(settings.shopId, Date.now()); const job = await this.outbox.enqueue({ shopId: settings.shopId, idempotencyKey: `notification-test:${settings.shopId}:${Math.floor(Date.now() / 60000)}`, eventType: "team_summary", payload: { shop: req.params.shop, status: "Configuração de envio validada" }, recipientType: "team", recipientEmail: recipient }); await this.outbox.run(1); const current = await prisma.notificationOutbox.findUnique({ where: { id: job.id }, select: { status: true } }); return res.json({ success: current?.status === "sent", status: current?.status }); } catch (error) { return this.error(res, error); } }
  async cron(req: Request, res: Response) { const expected = process.env.CRON_SECRET || "", received = String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""); if (!expected || Buffer.byteLength(expected) !== Buffer.byteLength(received) || !timingSafeEqual(Buffer.from(expected), Buffer.from(received))) return res.status(401).json({ error: "unauthorized" }); return this.reply(res, () => this.outbox.run(Math.min(50, Math.max(1, Number(req.query.limit) || 20)))); }
  private async reply(res: Response, fn: () => Promise<any>) { try { return res.json({ success: true, data: await fn() }); } catch (error) { return this.error(res, error); } }
  private error(res: Response, error: any) { return res.status(error?.statusCode || 400).json({ success: false, error: String(error?.message || "notification_error") }); }
}
