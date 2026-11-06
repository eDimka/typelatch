import type { Catalog } from "../catalog/types.js";
import type { Cart } from "../cart/types.js";
import { cartFingerprint } from "../cart/fingerprint.js";
import { calculateQuote } from "./calculate.js";
import { copyCatalog } from "../catalog/service.js";
import { snapshotShippingRates } from "./rate-book.js";
import { QuoteCache } from "./cache.js";
import type { Quote, ShippingRates } from "./types.js";
export class Checkout {
  private readonly cache = new QuoteCache();
  private readonly catalog: Catalog;
  private readonly rates: ShippingRates;
  constructor(catalog: Catalog, rates: ShippingRates) {
    this.catalog = copyCatalog(catalog);
    this.rates = snapshotShippingRates(rates);
  }
  preview(cart: Cart): Quote {
    const key = cartFingerprint(cart);
    const existing = this.cache.get(key);
    if (existing) return existing;
    const value = calculateQuote(cart, this.catalog, this.rates);
    this.cache.put(key, value);
    return { ...value };
  }
}
