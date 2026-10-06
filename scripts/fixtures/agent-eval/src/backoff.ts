export function exponentialDelay(attempt: number, baseMs: number, maximumMs: number): number {
  return Math.min(maximumMs, baseMs * 2 ** Math.max(0, attempt - 1))
}
