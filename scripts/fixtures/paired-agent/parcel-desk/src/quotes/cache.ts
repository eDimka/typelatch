import type { Quote } from "./types.js";
export class QuoteCache {
  private values = new Map<string, Quote>();
  get(key: string): Quote | undefined { const value = this.values.get(key); return value ? { ...value } : undefined; }
  put(key: string, value: Quote): void { this.values.set(key, { ...value }); }
}
