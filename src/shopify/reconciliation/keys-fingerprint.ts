import { createHash } from "node:crypto";

export const INVALID_KEY_NAME_MARKER = "<invalid-key-name>";
export const MAX_LOGGED_UNEXPECTED_KEYS = 20;

export const OBSERVABILITY_KEY_ALLOWLIST: readonly string[] = [
  "confirmation",
  "confirmationMessage",
  "shop",
  "requestId",
  "billingAttemptId",
];

const OBSERVABILITY_KEY_SET = new Set(OBSERVABILITY_KEY_ALLOWLIST);

export function sortKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

export function keysFingerprint(value: unknown): string {
  const keys = sortKeys(value);
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export function sanitizeObservabilityKeyName(name: string): string {
  return OBSERVABILITY_KEY_SET.has(name) ? name : INVALID_KEY_NAME_MARKER;
}

export function unexpectedKeys(value: unknown, accepted: readonly string[], limit = MAX_LOGGED_UNEXPECTED_KEYS): string[] {
  const raw = sortKeys(value).filter((key) => !accepted.includes(key));
  return raw.slice(0, limit).map(sanitizeObservabilityKeyName);
}