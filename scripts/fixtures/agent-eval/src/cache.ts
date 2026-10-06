type CacheOptions = { capacity: number; now?: () => number }
type Entry<Value> = { value: Value; expiresAt: number }

export class TTLCache<Value> {
  private readonly entries = new Map<string, Entry<Value>>()
  private readonly capacity: number
  private readonly now: () => number

  constructor(options: CacheOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) throw new RangeError("capacity must be a positive integer")
    this.capacity = options.capacity
    this.now = options.now ?? Date.now
  }

  set(key: string, value: Value, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be finite and nonnegative")
    if (ttlMs === 0) { this.entries.delete(key); return }
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs })
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() > entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  get size(): number {
    return this.entries.size
  }
}
