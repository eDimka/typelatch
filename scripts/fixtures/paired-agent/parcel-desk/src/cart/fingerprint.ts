import type { Cart } from "./types.js";
export const cartFingerprint = (cart: Cart): string => String(cart.lines.length);
