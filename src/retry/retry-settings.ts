import { RetryFailureAction, TeamNotificationFrequency } from "@prisma/client";

export const RETRY_DEFAULTS = {
  paymentRetryAttempts: 3, paymentRetryDays: 2,
  paymentFailureAction: RetryFailureAction.PAUSE_AND_NOTIFY,
  inventoryRetryAttempts: 5, inventoryRetryDays: 1,
  inventoryFailureAction: RetryFailureAction.SKIP_AND_NOTIFY,
  teamNotificationFrequency: TeamNotificationFrequency.WEEKLY_SUMMARY,
} as const;

export type RetrySettingsInput = {
  paymentRetryAttempts: number; paymentRetryDays: number; paymentFailureAction: RetryFailureAction;
  inventoryRetryAttempts: number; inventoryRetryDays: number; inventoryFailureAction: RetryFailureAction;
  teamNotificationFrequency: TeamNotificationFrequency;
};

export function validateRetrySettings(value: unknown): RetrySettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_body");
  const body = value as Record<string, unknown>;
  const integer = (name: string, min: number, max: number) => {
    const candidate = body[name];
    if (!Number.isInteger(candidate) || (candidate as number) < min || (candidate as number) > max) throw new Error(`invalid_${name}`);
    return candidate as number;
  };
  const action = (name: string) => {
    const candidate = body[name];
    if (!Object.values(RetryFailureAction).includes(candidate as RetryFailureAction)) throw new Error(`invalid_${name}`);
    return candidate as RetryFailureAction;
  };
  const frequency = body.teamNotificationFrequency;
  if (!Object.values(TeamNotificationFrequency).includes(frequency as TeamNotificationFrequency)) throw new Error("invalid_teamNotificationFrequency");
  return {
    paymentRetryAttempts: integer("paymentRetryAttempts", 0, 10), paymentRetryDays: integer("paymentRetryDays", 1, 14), paymentFailureAction: action("paymentFailureAction"),
    inventoryRetryAttempts: integer("inventoryRetryAttempts", 0, 10), inventoryRetryDays: integer("inventoryRetryDays", 1, 14), inventoryFailureAction: action("inventoryFailureAction"),
    teamNotificationFrequency: frequency as TeamNotificationFrequency,
  };
}
