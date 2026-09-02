import { createHash } from "node:crypto";

export function sortKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

export function keysFingerprint(value: unknown): string {
  const keys = sortKeys(value);
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export function unexpectedKeys(value: unknown, accepted: readonly string[]): string[] {
  return sortKeys(value).filter((key) => !accepted.includes(key));
}