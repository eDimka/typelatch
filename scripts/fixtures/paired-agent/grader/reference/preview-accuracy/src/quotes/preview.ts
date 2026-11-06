import type { Catalog } from "../catalog/types.js";
import type { Cart } from "../cart/types.js";
import { calculateQuote } from "./calculate.js";
import { copyCatalog } from "../catalog/service.js";
import { snapshotShippingRates } from "./rate-book.js";
import type { Quote, ShippingRates } from "./types.js";
export class Checkout {
  private readonly catalog: Catalog;
  private readonly rates: ShippingRates;
  constructor(catalog: Catalog, rates: ShippingRates) {
    this.catalog = copyCatalog(catalog);
    this.rates = snapshotShippingRates(rates);
  }
  preview(cart: Cart): Quote { return calculateQuote(cart, this.catalog, this.rates); }
}
