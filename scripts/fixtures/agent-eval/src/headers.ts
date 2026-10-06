export function cacheControlHeader(ttlSeconds: number): string {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return "no-store"
  return `private, max-age=${Math.floor(ttlSeconds)}`
}
