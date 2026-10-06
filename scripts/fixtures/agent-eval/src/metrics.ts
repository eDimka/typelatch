export class RuntimeMetrics {
  readonly counts = new Map<string, number>()
  record(name: "cache.hit" | "cache.miss" | "retry.failure"): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1)
  }
}
