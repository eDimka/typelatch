// Cache expiration is independent of login session expiration.
export function cacheEntryFresh(writtenAt: number, ttlMs: number, now: number): boolean {
  return writtenAt + ttlMs > now;
}
