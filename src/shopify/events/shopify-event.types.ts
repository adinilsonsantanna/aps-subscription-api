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
  shopifyShopId?: string;
  shopifyEventId?: string;
  topic: ShopifyEventTopic;
  webhookId: string;
  payload: ShopifyEventPayload;
  contract?: NormalizedShopifyContract;
  receivedAt: Date;
  triggeredAt?: Date;
}

export interface NormalizedShopifyContract {
  id: string;
  revisionId?: string;
  status: string;
  nextBillingAt?: string;
  currencyCode: string;
  originOrder?: { id: string; financialStatus?: string; amount?: string; currencyCode?: string; processedAt?: string };
  customer?: { id: string; email?: string; name?: string };
  billingPolicy: { interval: string; intervalCount: number };
  deliveryPolicy: { interval: string; intervalCount: number };
  lines: Array<{ id: string; title?: string; productId?: string; variantId?: string; quantity: number; currentPrice: { amount: string; currencyCode: string }; sellingPlanId?: string }>;
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

function validatedContract(value: unknown): NormalizedShopifyContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShopifyEventValidationError("Invalid contract");
  const contract = value as Record<string, unknown>;
  const requiredString = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate.trim()) throw new ShopifyEventValidationError("Invalid contract");
    return candidate.trim();
  };
  const optionalValue = (candidate: unknown) => typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  const gid = (candidate: unknown, resource: string, optional = false) => {
    const result = optional ? optionalValue(candidate) : requiredString(candidate);
    if (result === undefined) return undefined;
    if (!new RegExp(`^gid://shopify/${resource}/[^/]+$`).test(result)) throw new ShopifyEventValidationError("Invalid contract identifier");
    return result;
  };
  const policy = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new ShopifyEventValidationError("Invalid contract");
    const item = candidate as Record<string, unknown>;
    if (!Number.isInteger(item.intervalCount) || Number(item.intervalCount) < 1) throw new ShopifyEventValidationError("Invalid contract");
    return { interval: requiredString(item.interval), intervalCount: Number(item.intervalCount) };
  };
  const nested = (candidate: unknown) => candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
  if (!Array.isArray(contract.lines)) throw new ShopifyEventValidationError("Invalid contract");
  const origin = nested(contract.originOrder), customer = nested(contract.customer);
  return {
    id: gid(contract.id, "SubscriptionContract")!, ...(optionalValue(contract.revisionId) && { revisionId: optionalValue(contract.revisionId) }), status: requiredString(contract.status), currencyCode: requiredString(contract.currencyCode),
    ...(optionalValue(contract.nextBillingAt) && { nextBillingAt: optionalValue(contract.nextBillingAt) }),
    billingPolicy: policy(contract.billingPolicy), deliveryPolicy: policy(contract.deliveryPolicy),
    ...(origin && { originOrder: { id: gid(origin.id, "Order")!, ...(optionalValue(origin.financialStatus) && { financialStatus: optionalValue(origin.financialStatus) }), ...(optionalValue(origin.amount) && { amount: optionalValue(origin.amount) }), ...(optionalValue(origin.currencyCode) && { currencyCode: optionalValue(origin.currencyCode) }), ...(optionalValue(origin.processedAt) && { processedAt: optionalValue(origin.processedAt) }) } }),
    ...(customer && { customer: { id: gid(customer.id, "Customer")!, ...(optionalValue(customer.email) && { email: optionalValue(customer.email) }), ...(optionalValue(customer.name) && { name: optionalValue(customer.name) }) } }),
    lines: contract.lines.map((candidate) => { const line = nested(candidate); if (!line || !Number.isInteger(line.quantity) || Number(line.quantity) < 1) throw new ShopifyEventValidationError("Invalid contract"); const price = nested(line.currentPrice); if (!price) throw new ShopifyEventValidationError("Invalid contract"); return { id: gid(line.id, "SubscriptionLine")!, ...(optionalValue(line.title) && { title: optionalValue(line.title) }), ...(gid(line.productId, "Product", true) && { productId: gid(line.productId, "Product", true) }), ...(gid(line.variantId, "ProductVariant", true) && { variantId: gid(line.variantId, "ProductVariant", true) }), quantity: Number(line.quantity), currentPrice: { amount: requiredString(price.amount), currencyCode: requiredString(price.currencyCode) }, ...(gid(line.sellingPlanId, "SellingPlan", true) && { sellingPlanId: gid(line.sellingPlanId, "SellingPlan", true) }) }; }),
  };
}

export function validateIncomingShopifyEvent(value: unknown): IncomingShopifyEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ShopifyEventValidationError("Invalid request body");
  }

  const body = value as Record<string, unknown>;
  const shop = typeof body.shop === "string" ? body.shop.trim().toLowerCase() : "";
  const webhookId = typeof body.webhookId === "string" ? body.webhookId.trim() : "";
  const shopifyShopId = typeof body.shopifyShopId === "string" ? body.shopifyShopId.trim() : undefined;
  const shopifyEventId = typeof body.shopifyEventId === "string" ? body.shopifyEventId.trim() : undefined;

  if (!/^[a-z0-9][a-z0-9.-]{1,251}[a-z0-9]$/.test(shop)) {
    throw new ShopifyEventValidationError("Invalid shop");
  }
  if (!isTopic(body.topic)) {
    throw new ShopifyEventValidationError("Unknown topic");
  }
  if (!webhookId || webhookId.length > 255) {
    throw new ShopifyEventValidationError("Invalid webhookId");
  }
  if (shopifyShopId && !/^gid:\/\/shopify\/Shop\/[^/]+$/.test(shopifyShopId)) throw new ShopifyEventValidationError("Invalid shopifyShopId");
  if (shopifyEventId && shopifyEventId.length > 255) throw new ShopifyEventValidationError("Invalid shopifyEventId");
  if (!body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    throw new ShopifyEventValidationError("Invalid payload");
  }

  const receivedAt = typeof body.receivedAt === "string" ? new Date(body.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime())) {
    throw new ShopifyEventValidationError("Invalid receivedAt");
  }
  const triggeredAt = typeof body.triggeredAt === "string" ? new Date(body.triggeredAt) : undefined;
  if (body.topic === "app/uninstalled" && (!triggeredAt || Number.isNaN(triggeredAt.getTime()))) {
    throw new ShopifyEventValidationError("Invalid triggeredAt");
  }

  return {
    shop,
    ...(shopifyShopId && { shopifyShopId }),
    ...(shopifyEventId && { shopifyEventId }),
    topic: body.topic,
    webhookId,
    payload: sanitizePayloadValue(body.payload) as ShopifyEventPayload,
    ...((body.topic === "subscription_contracts/create" || body.topic === "subscription_contracts/update")
      ? { contract: validatedContract(body.contract) }
      : {}),
    receivedAt,
    ...(triggeredAt && { triggeredAt }),
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
