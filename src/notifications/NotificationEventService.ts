import { Prisma, PrismaClient, TeamNotificationFrequency } from "@prisma/client";
import { NotificationOutboxService } from "./NotificationOutboxService";
import { waitUntil } from "@vercel/functions";
import { renderNotification } from "./notification-template";

const TOGGLE_BY_EVENT: Record<string, string> = { payment_failed: "paymentFailedEnabled", retry_scheduled: "retryScheduledEnabled", inventory_insufficient: "inventoryFailedEnabled", inventory_retry_scheduled: "inventoryRetryEnabled", subscription_paused: "pausedEnabled", subscription_cancelled: "cancelledEnabled", renewal_succeeded: "renewalSucceededEnabled" };
export function summaryWindow(frequency: TeamNotificationFrequency, now: Date) { const local = new Date(now.getTime() - 3 * 60 * 60_000), start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3)); if (frequency === TeamNotificationFrequency.WEEKLY_SUMMARY) start.setUTCDate(start.getUTCDate() - ((local.getUTCDay() + 6) % 7)); const end = new Date(start); end.setUTCDate(end.getUTCDate() + (frequency === TeamNotificationFrequency.WEEKLY_SUMMARY ? 7 : 1)); return { key: `${frequency}:${start.toISOString()}`, end }; }

export class NotificationEventService {
  constructor(private db: PrismaClient = new PrismaClient(), private outbox = new NotificationOutboxService(db), private defer: (work: Promise<unknown>) => void = waitUntil, private fetchFn: typeof fetch = fetch) {}
  async emit(input: { shopId: string; eventType: string; sourceKey: string; payload: Record<string, unknown>; customerEmail?: string | null; occurredAt?: Date }) {
    if (!("notificationSettings" in this.db)) return { customer: 0, team: 0 };
    const settings = await this.db.notificationSettings.findUnique({ where: { shopId: input.shopId } }); if (!settings) return { customer: 0, team: 0 };
    const enabled = Boolean((settings as unknown as Record<string, unknown>)[TOGGLE_BY_EVENT[input.eventType]]); if (!enabled) return { customer: 0, team: 0 };
    let customer = 0, team = 0;
    const immediate: string[] = [], customerEmail = settings.customerNotificationsEnabled ? input.customerEmail || await this.resolveCustomerEmail(input.shopId, input.payload.subscriptionId) : null;
    if (settings.customerNotificationsEnabled && customerEmail) { const delivery = await this.outbox.enqueue({ shopId: input.shopId, idempotencyKey: `customer:${input.shopId}:${input.eventType}:${input.sourceKey}:${customerEmail.toLowerCase()}`, eventType: input.eventType, payload: input.payload, recipientType: "customer", recipientEmail: customerEmail }); customer = 1; if (delivery?.id) immediate.push(delivery.id); }
    if (settings.teamFrequency === TeamNotificationFrequency.NEVER) { for (const id of immediate) this.defer(this.outbox.runOne(id)); return { customer, team }; }
    if (settings.teamFrequency === TeamNotificationFrequency.IMMEDIATELY) { for (const email of settings.teamEmails) { const delivery = await this.outbox.enqueue({ shopId: input.shopId, idempotencyKey: `team:${input.shopId}:${input.eventType}:${input.sourceKey}:${email.toLowerCase()}:IMMEDIATELY`, eventType: input.eventType, payload: input.payload, recipientType: "team", recipientEmail: email }); if (delivery?.id) immediate.push(delivery.id); team++; } for (const id of immediate) this.defer(this.outbox.runOne(id)); return { customer, team }; }
    for (const id of immediate) this.defer(this.outbox.runOne(id));
    const window = summaryWindow(settings.teamFrequency, input.occurredAt ?? new Date()); const key = `event:${input.shopId}:${input.eventType}:${input.sourceKey}:${settings.teamFrequency}`; await this.db.notificationEvent.upsert({ where: { idempotencyKey: key }, create: { shopId: input.shopId, idempotencyKey: key, eventType: input.eventType, payload: input.payload as Prisma.InputJsonValue, frequency: settings.teamFrequency, windowKey: window.key, windowEndAt: window.end }, update: {} }); return { customer, team: 1 };
  }
  async materializeSummaries(limit = 20, now = new Date()) {
    const groups = await this.db.notificationEvent.findMany({ where: { includedInOutboxId: null, windowEndAt: { lte: now }, frequency: { in: [TeamNotificationFrequency.DAILY_SUMMARY, TeamNotificationFrequency.WEEKLY_SUMMARY] } }, distinct: ["shopId", "frequency", "windowKey"], take: limit, select: { shopId: true, frequency: true, windowKey: true } });
    let created = 0;
    for (const group of groups) await this.db.$transaction(async tx => {
      if ("$executeRaw" in tx) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${group.shopId}:${group.frequency}:${group.windowKey}`}))`;
      const events = await tx.notificationEvent.findMany({ where: { shopId: group.shopId, frequency: group.frequency, windowKey: group.windowKey, includedInOutboxId: null }, orderBy: { createdAt: "asc" } });
      if (!events.length) return;
      const settings = await tx.notificationSettings.findUnique({ where: { shopId: group.shopId }, include: { shop: { select: { name: true, domain: true } } } });
      if (!settings || settings.teamFrequency === TeamNotificationFrequency.NEVER || !settings.teamEmails.length) return;
      const eventIds = events.map(event => event.id), eventPayload = events.map(event => ({ type: event.eventType, payload: event.payload })), windowStart = String(group.windowKey || "").split(":").slice(1).join(":"), windowEnd = events[0].windowEndAt?.toISOString(), shop = settings.shop?.name || settings.shop?.domain || group.shopId;
      let markerId: string | null = null;
      for (const email of settings.teamEmails) {
        const baseKey = `summary:${group.shopId}:${group.frequency}:${group.windowKey}:${email.toLowerCase()}`;
        const existing = await tx.notificationOutbox.findUnique({ where: { idempotencyKey: baseKey } });
        let delivery;
        if (existing?.status === "pending") { const included = [...new Set([...existing.includedEventIds, ...eventIds])], prior = ((existing.payload as Prisma.JsonObject).events as Prisma.JsonArray | undefined) || [], payload = { frequency: group.frequency, shop, windowStart, windowEnd, events: [...prior, ...eventPayload] }, rendered = renderNotification("team_summary", payload); delivery = await tx.notificationOutbox.update({ where: { id: existing.id }, data: { includedEventIds: included, payload: payload as Prisma.InputJsonValue, subject: rendered.subject, htmlBody: rendered.html, textBody: rendered.text } }); }
        else { const key = existing ? `${baseKey}:supplement:${eventIds.join("-")}` : baseKey, payload = { frequency: group.frequency, shop, windowStart, windowEnd, events: eventPayload }, rendered = renderNotification("team_summary", payload); delivery = await tx.notificationOutbox.upsert({ where: { idempotencyKey: key }, create: { shopId: group.shopId, idempotencyKey: key, frequency: group.frequency, eventType: "team_summary", payload, recipientType: "team", recipientEmail: email, includedEventIds: eventIds, subject: rendered.subject, htmlBody: rendered.html, textBody: rendered.text, status: "pending", availableAt: now }, update: {} }); }
        markerId ??= delivery.id; created++;
      }
      if (markerId) await tx.notificationEvent.updateMany({ where: { id: { in: eventIds }, includedInOutboxId: null }, data: { includedInOutboxId: markerId } });
    });
    return { groups: groups.length, created };
  }
  private async resolveCustomerEmail(shopId: string, subscriptionId: unknown) {
    if (typeof subscriptionId !== "string" || !("subscription" in this.db)) return null;
    const subscription = await this.db.subscription.findFirst({ where: { id: subscriptionId, shopId }, select: { id: true, shopifyContractId: true, shopifyCustomerEmail: true, shop: { select: { domain: true, accessToken: true } } } });
    if (!subscription || subscription.shopifyCustomerEmail || !subscription.shopifyContractId) return this.validEmail(subscription?.shopifyCustomerEmail) ? subscription!.shopifyCustomerEmail : null;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8_000);
    try { const response = await this.fetchFn(`https://${subscription.shop.domain}/admin/api/2026-07/graphql.json`, { method: "POST", headers: { "content-type": "application/json", "X-Shopify-Access-Token": subscription.shop.accessToken }, body: JSON.stringify({ query: `query SubscriptionContractCustomer($id: ID!) { subscriptionContract(id: $id) { customer { defaultEmailAddress { emailAddress } } } }`, variables: { id: subscription.shopifyContractId } }), signal: controller.signal }); if (!response.ok) return null; const body = await response.json() as { data?: { subscriptionContract?: { customer?: { defaultEmailAddress?: { emailAddress?: string | null } | null } | null } | null } }; const email = body.data?.subscriptionContract?.customer?.defaultEmailAddress?.emailAddress?.trim().toLowerCase(); if (!this.validEmail(email)) return null; await this.db.subscription.updateMany({ where: { id: subscription.id, shopId, shopifyCustomerEmail: null }, data: { shopifyCustomerEmail: email } }); return email; } catch { return null; } finally { clearTimeout(timer); }
  }
  private validEmail(value: unknown): value is string { return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254; }
}
