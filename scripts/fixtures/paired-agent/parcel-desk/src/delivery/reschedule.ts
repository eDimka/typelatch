import type { DeliveryState } from "./types.js";
import type { DeliveryWindow } from "../shared/types.js";
import { findOrder } from "../orders/read.js";
import { changeOrderWindow } from "../orders/change.js";
import { isValidWindow } from "./window.js";
export function reschedule(state: DeliveryState, orderId: string, window: DeliveryWindow): boolean {
  const order = findOrder(state.orders, orderId);
  if (!order || order.state !== "open" || !isValidWindow(window)) return false;
  changeOrderWindow(order, window);
  return true;
}
