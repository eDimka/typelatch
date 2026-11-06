import type { Catalog, Product } from "./types.js";
export function requireProduct(catalog: Catalog, sku: string): Product {
  const product = Object.hasOwn(catalog, sku) ? catalog[sku] : undefined;
  if (!product) throw new Error(`Unknown SKU: ${sku}`);
  return product;
}
