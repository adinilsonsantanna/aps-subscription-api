export type BillingNotificationIdentityInput = {
  shopifyBillingAttemptId?: string | null;
  idempotencyKey?: string | null;
  shopifyContractId?: string | null;
  billingCycleAt?: Date | string | null;
};

function normalizedTimestamp(value?: Date | string | null) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function canonicalBillingSourceKey(input: BillingNotificationIdentityInput) {
  const attemptId = input.shopifyBillingAttemptId?.trim();
  if (attemptId) return `billing-attempt:${attemptId}`;
  const idempotencyKey = input.idempotencyKey?.trim();
  if (idempotencyKey) return `billing-idempotency:${idempotencyKey}`;
  const contractId = input.shopifyContractId?.trim();
  const cycle = normalizedTimestamp(input.billingCycleAt);
  if (contractId && cycle) return `billing-cycle:${contractId}:${cycle}`;
  throw new Error("billing_notification_identity_unavailable");
}
