import { PrismaClient, TeamNotificationFrequency } from "@prisma/client";
import { domainFromEmail, normalizeEmail, securePublicSettings } from "./notification-utils";
const FREQUENCIES = new Set(["IMMEDIATELY", "DAILY_SUMMARY", "WEEKLY_SUMMARY", "NEVER"]);
const TOGGLES = ["customerNotificationsEnabled", "paymentFailedEnabled", "retryScheduledEnabled", "inventoryFailedEnabled", "inventoryRetryEnabled", "pausedEnabled", "cancelledEnabled", "renewalSucceededEnabled"] as const;
export class NotificationSettingsService {
  constructor(private db: PrismaClient = new PrismaClient()) {}
  private async shop(domain: string | string[]) { const shop = await this.db.shop.findUnique({ where: { domain: String(domain).toLowerCase() } }); if (!shop) throw Object.assign(new Error("shop_not_found"), { statusCode: 404 }); return shop; }
  async get(shopDomain: string | string[]) { const shop = await this.shop(shopDomain); const settings = await this.db.notificationSettings.findUnique({ where: { shopId: shop.id }, include: { activeSendingDomain: true } }); return securePublicSettings(settings ?? { shopId: shop.id, fromName: null, fromEmail: null, replyTo: null, activeFromName: null, activeFromEmail: null, activeReplyTo: null, teamEmails: [], teamFrequency: "WEEKLY_SUMMARY", customerNotificationsEnabled: false }); }
  async save(shopDomain: string, rawInput: unknown) {
    const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
    const shop = await this.shop(shopDomain), fromName = String(input.fromName ?? "").trim(); if (!fromName || fromName.length > 100) throw new Error("invalid_from_name");
    const fromEmail = normalizeEmail(input.fromEmail), replyTo = normalizeEmail(input.replyTo), teamEmails = [...new Set((Array.isArray(input.teamEmails) ? input.teamEmails : String(input.teamEmails ?? "").split(/[\s,;]+/)).filter(Boolean).map(normalizeEmail))]; if (!teamEmails.length || teamEmails.length > 20) throw new Error("invalid_team_emails");
    const requestedFrequency = String(input.teamFrequency); if (!FREQUENCIES.has(requestedFrequency)) throw new Error("invalid_team_frequency"); const teamFrequency = requestedFrequency as TeamNotificationFrequency;
    const current = await this.db.notificationSettings.findUnique({ where: { shopId: shop.id }, include: { activeSendingDomain: true } });
    const requestedDomain = domainFromEmail(fromEmail), keepActive = Boolean(current?.activeSendingDomain?.sendingVerified && current.activeSendingDomain.domain !== requestedDomain);
    const toggles = Object.fromEntries(TOGGLES.map(name => [name, input[name] === true]));
    const sameVerifiedDomain = current?.activeSendingDomain?.sendingVerified && current.activeSendingDomain.domain === requestedDomain;
    const activeSnapshot = sameVerifiedDomain ? { activeSendingDomainId: current.activeSendingDomain!.id, activeFromName: fromName, activeFromEmail: fromEmail, activeReplyTo: replyTo } : {};
    const saved = await this.db.notificationSettings.upsert({ where: { shopId: shop.id }, create: { shopId: shop.id, fromName, fromEmail, replyTo, teamEmails, teamFrequency, ...toggles }, update: { fromName, fromEmail, replyTo, teamEmails, teamFrequency, ...toggles, ...(keepActive ? {} : sameVerifiedDomain ? activeSnapshot : { activeSendingDomainId: null, activeFromName: null, activeFromEmail: null, activeReplyTo: null }) }, include: { activeSendingDomain: true } });
    return securePublicSettings(saved);
  }
}
