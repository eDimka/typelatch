import { TTLCache } from "./cache.ts"
import { retry } from "./retry.ts"

export function createReader(load: (key: string) => Promise<string>, now: () => number = Date.now) {
  const cache = new TTLCache<string>({ capacity: 100, now })
  return async (key: string): Promise<string> => {
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const value = await retry(() => load(key), { maxAttempts: 3, delayMs: 100, deadlineMs: now() + 2000, now })
    cache.set(key, value, 5000)
    return value
  }
}
