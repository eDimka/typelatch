import type { Cart } from "./types.js";
import type { Catalog } from "../catalog/types.js";
import { requireProduct } from "../catalog/read.js";
export const merchandiseTotal = (cart: Cart, catalog: Catalog): number => cart.lines.reduce((sum, line) => sum + requireProduct(catalog, line.sku).unitCents * line.quantity, 0);
