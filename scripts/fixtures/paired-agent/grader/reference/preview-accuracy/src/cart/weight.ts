import type { Cart } from "./types.js";
import type { Catalog } from "../catalog/types.js";
import { requireProduct } from "../catalog/read.js";
export const packedWeight = (cart: Cart, catalog: Catalog): number => cart.lines.reduce((total, line) => total + requireProduct(catalog, line.sku).unitGrams * line.quantity, 0);
