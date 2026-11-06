import type { Catalog } from "../catalog/types.js";
import type { Cart } from "../cart/types.js";
import { assertCart } from "../cart/validate.js";
import { merchandiseTotal } from "../cart/subtotal.js";
import { packedWeight } from "../cart/weight.js";
import { shippingTotal } from "./shipping.js";
import type { Quote, ShippingRates } from "./types.js";
export function calculateQuote(cart: Cart, catalog: Catalog, rates: ShippingRates): Quote {
  assertCart(cart);
  const merchandiseCents = merchandiseTotal(cart, catalog);
  const grams = packedWeight(cart, catalog);
  const shippingCents = shippingTotal(grams, cart.region, rates);
  return { merchandiseCents, grams, shippingCents, totalCents: merchandiseCents + shippingCents };
}
