export const SUBSCRIPTION_CYCLE_CONTRACT_VERSION = "aps.subscription-cycle.v1" as const;
export const RETRY_OPERATIONS = ["inventory", "charge", "reconcile"] as const;
export const RETRY_STATUSES = ["pending", "succeeded", "failed"] as const;
export const CONTRACT_HTTP_STATUSES = [200, 400, 401, 403, 409, 422, 429, 500, 502, 503, 504] as const;

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const gid = (value: unknown, resource: string) => typeof value === "string" && value.startsWith(`gid://shopify/${resource}/`);
export function validateRetryRequest(value: unknown) {
  if (!object(value) || typeof value.shop !== "string" || !gid(value.contractId, "SubscriptionContract") || !RETRY_OPERATIONS.includes(value.operation as never) || typeof value.idempotencyKey !== "string") return false;
  if (value.operation === "inventory") return Array.isArray(value.lines) && value.lines.length > 0 && value.lines.every(line => object(line) && gid(line.variantId, "ProductVariant") && Number.isInteger(line.quantity) && Number(line.quantity) > 0);
  if (value.operation === "reconcile" && value.billingAttemptId !== undefined) return gid(value.billingAttemptId, "SubscriptionBillingAttempt");
  return typeof value.billingCycleAt === "string" && !Number.isNaN(Date.parse(value.billingCycleAt));
}
export function validateRetryResponse(value: unknown) {
  if (!object(value) || typeof value.success !== "boolean" || typeof value.uncertain !== "boolean") return false;
  for (const key of ["errorCode", "errorMessage", "billingAttemptId", "orderId", "amount", "currencyCode"]) if (!(key in value) || (value[key] !== null && typeof value[key] !== "string")) return false;
  return value.status === undefined || RETRY_STATUSES.includes(value.status as never);
}
export function validateContractStatus(status: number) { return CONTRACT_HTTP_STATUSES.includes(status as never); }
