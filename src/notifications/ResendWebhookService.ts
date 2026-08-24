import { Prisma, PrismaClient } from "@prisma/client";
import { Resend } from "resend";
import { ResendDomainService } from "./ResendDomainService";
type WebhookEvent = { id?: string; type?: string; created_at?: string; data?: Record<string, unknown> };
export class ResendWebhookService {
  constructor(private db: PrismaClient = new PrismaClient(), private resend: Resend = new Resend(process.env.RESEND_API_KEY), private domains = new ResendDomainService(db, resend)) {}
  async handle(raw: string, headers: { id?: string; timestamp?: string; signature?: string }) {
    if (!process.env.RESEND_WEBHOOK_SECRET || !headers.id || !headers.timestamp || !headers.signature) throw Object.assign(new Error("invalid_signature"), { statusCode: 400 });
    let event: WebhookEvent; try { event = this.resend.webhooks.verify({ payload: raw, headers: { id: headers.id, timestamp: headers.timestamp, signature: headers.signature }, webhookSecret: process.env.RESEND_WEBHOOK_SECRET }) as unknown as WebhookEvent; } catch { throw Object.assign(new Error("invalid_signature"), { statusCode: 400 }); }
    const providerEventId = String(event.id || headers.id); if (await this.db.notificationDeliveryEvent.findUnique({ where: { providerEventId } })) return { duplicate: true };
    const type = String(event.type), data = event.data || {}; if (!["email.delivered", "email.bounced", "email.complained", "email.suppressed", "domain.updated"].includes(type)) return { ignored: true };
    try {
      if (type === "domain.updated") { const providerDomainId = String(data.id || ""), domain = await this.db.sendingDomain.findUnique({ where: { providerDomainId } }); if (domain) await this.domains.persistProviderState(domain, data); await this.db.notificationDeliveryEvent.create({ data: { shopId: domain?.shopId, providerEventId, providerDomainId, type, payload: event as Prisma.InputJsonValue, occurredAt: event.created_at ? new Date(event.created_at) : null } }); return { processed: true }; }
      const messageId = String(data.email_id || data.id || ""), outbox = messageId ? await this.db.notificationOutbox.findUnique({ where: { providerMessageId: messageId } }) : null, statuses: Record<string, string> = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.suppressed": "suppressed" }, status = statuses[type], precedence: Record<string, number> = { sent: 0, delivered: 1, bounced: 2, suppressed: 3, complained: 4 };
      await this.db.$transaction(async tx => { await tx.notificationDeliveryEvent.create({ data: { shopId: outbox?.shopId, providerEventId, providerMessageId: messageId || null, type, payload: event as Prisma.InputJsonValue, occurredAt: event.created_at ? new Date(event.created_at) : null } }); if (outbox && (precedence[status] ?? 0) >= (precedence[outbox.status] ?? 0)) await tx.notificationOutbox.update({ where: { id: outbox.id }, data: { status, ...(status === "delivered" ? { deliveredAt: event.created_at ? new Date(event.created_at) : new Date() } : {}) } }); }); return { processed: true };
    } catch (error) { if ((error instanceof Prisma.PrismaClientKnownRequestError || (typeof error === "object" && error !== null)) && (error as { code?: string }).code === "P2002") return { duplicate: true }; throw error; }
  }
}
