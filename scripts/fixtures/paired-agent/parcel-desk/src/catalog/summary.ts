import type { Catalog } from "./types.js";
export const catalogSummary = (catalog: Catalog): string[] => Object.values(catalog).map(product => `${product.sku}: ${product.title}`);
