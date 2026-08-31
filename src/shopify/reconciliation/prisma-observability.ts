import { Prisma } from "@prisma/client";

export type AdministrativeReconciliationPrismaStage =
  | "transaction_initialization"
  | "shop_lookup"
  | "subscription_lookup"
  | "billing_attempt_lookup"
  | "subscription_order_lookup"
  | "billing_retry_cycle_lookup"
  | "reconciliation_audit_lookup"
  | "billing_attempt_update"
  | "subscription_order_update"
  | "billing_retry_cycle_update"
  | "reconciliation_audit_create";

const stages = new WeakMap<object, AdministrativeReconciliationPrismaStage>();
const safeIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value);

export function recordAdministrativeReconciliationPrismaStage(
  error: unknown,
  stage: AdministrativeReconciliationPrismaStage,
) {
  if (typeof error === "object" && error !== null) stages.set(error, stage);
}

function safeTarget(value: unknown): string | string[] | undefined {
  if (safeIdentifier(value)) return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(safeIdentifier)) return value;
  return undefined;
}

export function sanitizedAdministrativeReconciliationPrismaError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = error.meta && typeof error.meta === "object" ? error.meta : undefined;
  const prismaModelName = safeIdentifier(meta?.modelName) ? meta.modelName : undefined;
  const prismaTarget = safeTarget(meta?.target);

  return {
    errorType: "PrismaClientKnownRequestError",
    prismaCode: /^P\d{4}$/.test(error.code) ? error.code : "UNKNOWN",
    prismaStage: stages.get(error) ?? "unknown",
    ...(prismaModelName ? { prismaModelName } : {}),
    ...(prismaTarget ? { prismaTarget } : {}),
    clientVersion: /^[0-9A-Za-z.+-]{1,64}$/.test(error.clientVersion) ? error.clientVersion : "unknown",
  };
}
