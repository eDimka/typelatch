import type { Cart } from "./types.js";
import type { Catalog } from "../catalog/types.js";
import { requireProduct } from "../catalog/read.js";
export function packedWeight(cart: Cart, catalog: Catalog): number {
  const seen = new Set<string>();
  let grams = 0;
  for (const line of cart.lines) {
    if (seen.has(line.sku)) continue;
    seen.add(line.sku);
    grams += requireProduct(catalog, line.sku).unitGrams * line.quantity;
  }
  return grams;
}
