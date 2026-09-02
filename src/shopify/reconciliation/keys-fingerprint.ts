import { createHash } from "node:crypto";

const SAFE_KEY_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
export const INVALID_KEY_NAME_MARKER = "<invalid-key-name>";
export const MAX_LOGGED_UNEXPECTED_KEYS = 20;

export function sortKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

export function keysFingerprint(value: unknown): string {
  const keys = sortKeys(value);
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export function sanitizeObservabilityKeyName(name: string): string {
  return SAFE_KEY_NAME.test(name) ? name : INVALID_KEY_NAME_MARKER;
}

export function unexpectedKeys(value: unknown, accepted: readonly string[], limit = MAX_LOGGED_UNEXPECTED_KEYS): string[] {
  const raw = sortKeys(value).filter((key) => !accepted.includes(key));
  return raw.slice(0, limit).map(sanitizeObservabilityKeyName);
}