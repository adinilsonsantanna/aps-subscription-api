export type RetryDecision = { exhausted: boolean; nextAttempt: number | null; scheduledAt: Date | null };
export function nextRetry(attemptNumber: number, maxRetries: number, retryDays: number, now: Date): RetryDecision {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 0 || !Number.isInteger(maxRetries) || maxRetries < 0 || !Number.isInteger(retryDays) || retryDays < 1) throw new Error("invalid_retry_policy");
  if (attemptNumber >= maxRetries) return { exhausted: true, nextAttempt: null, scheduledAt: null };
  return { exhausted: false, nextAttempt: attemptNumber + 1, scheduledAt: new Date(now.getTime() + retryDays * 86_400_000) };
}

export function advanceBillingDate(from: Date, interval: string | null, count: number | null) {
  const result = new Date(from);
  const amount = Math.max(1, count || 1);
  if (interval?.toLowerCase() === "day") result.setUTCDate(result.getUTCDate() + amount);
  else if (interval?.toLowerCase() === "week") result.setUTCDate(result.getUTCDate() + amount * 7);
  else if (interval?.toLowerCase() === "year") setClampedUtcDate(result, result.getUTCFullYear() + amount, result.getUTCMonth());
  else {
    const target = result.getUTCMonth() + amount;
    setClampedUtcDate(result, result.getUTCFullYear() + Math.floor(target / 12), ((target % 12) + 12) % 12);
  }
  return result;
}

function setClampedUtcDate(date: Date, year: number, month: number) {
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(year, month, Math.min(day, lastDay));
}
