export const acceptedShopifyEventTopics = [
  "subscription_contracts/create",
  "subscription_contracts/update",
  "subscription_billing_attempts/success",
  "subscription_billing_attempts/failure",
  "subscription_billing_attempts/challenged",
  "app/uninstalled",
] as const;

export type ShopifyEventTopic = (typeof acceptedShopifyEventTopics)[number];
export type ShopifyEventPayload = Record<string, unknown>;

export interface IncomingShopifyEvent {
  shop: string;
  topic: ShopifyEventTopic;
  webhookId: string;
  payload: ShopifyEventPayload;
  receivedAt: Date;
}

export class ShopifyEventValidationError extends Error {}
export class ShopifyShopNotFoundError extends Error {}

const sensitivePayloadKeys = new Set([
  "access_token",
  "api_key",
  "api_secret",
  "card_number",
  "credit_card_number",
  "cvc",
  "cvv",
  "password",
  "secret",
  "verification_value",
]);

function sanitizePayloadValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizePayloadValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitivePayloadKeys.has(key.toLowerCase()))
      .map(([key, nestedValue]) => [key, sanitizePayloadValue(nestedValue)]),
  );
}

function isTopic(value: unknown): value is ShopifyEventTopic {
  return typeof value === "string" &&
    acceptedShopifyEventTopics.includes(value as ShopifyEventTopic);
}

export function validateIncomingShopifyEvent(value: unknown): IncomingShopifyEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShopifyEventValidationError("Invalid request body");
  }

  const body = value as Record<string, unknown>;
  const shop = typeof body.shop === "string" ? body.shop.trim().toLowerCase() : "";
  const webhookId = typeof body.webhookId === "string" ? body.webhookId.trim() : "";

  if (!/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(shop)) {
    throw new ShopifyEventValidationError("Invalid shop");
  }
  if (!isTopic(body.topic)) {
    throw new ShopifyEventValidationError("Unknown topic");
  }
  if (!webhookId || webhookId.length > 255) {
    throw new ShopifyEventValidationError("Invalid webhookId");
  }
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    throw new ShopifyEventValidationError("Invalid payload");
  }

  const receivedAt = typeof body.receivedAt === "string" ? new Date(body.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) {
    throw new ShopifyEventValidationError("Invalid receivedAt");
  }

  return {
    shop,
    topic: body.topic,
    webhookId,
    payload: sanitizePayloadValue(body.payload) as ShopifyEventPayload,
    receivedAt,
  };
}

export function optionalString(payload: ShopifyEventPayload, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function optionalInteger(payload: ShopifyEventPayload, ...keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

export function optionalObject(payload: ShopifyEventPayload, key: string): ShopifyEventPayload {
  const value = payload[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ShopifyEventPayload
    : {};
}

export function optionalDate(payload: ShopifyEventPayload, ...keys: string[]) {
  const value = optionalString(payload, ...keys);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function contractIdFromPayload(payload: ShopifyEventPayload) {
  const nestedContract = optionalObject(payload, "subscription_contract");
  return optionalString(
    payload,
    "admin_graphql_api_subscription_contract_id",
    "subscription_contract_id",
    "contract_id",
  ) ?? optionalString(nestedContract, "admin_graphql_api_id", "id");
}
