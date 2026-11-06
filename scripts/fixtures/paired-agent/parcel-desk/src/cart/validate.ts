import type { Cart } from "./types.js";
export function assertCart(cart: Cart): void {
  if (!cart.region) throw new Error("Region is required");
  for (const line of cart.lines) if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new Error("Quantity must be a positive integer");
}
