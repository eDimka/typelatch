// Exponential retry delay is capped so retries do not wait forever.
export function retryDelay(attempt: number, baseMs: number, maximumMs: number): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempt));
}
