import type { DeliveryState } from "./types.js";
import { copyWindow } from "../shared/copy.js";
export function copyState(state: DeliveryState): DeliveryState {
  return { orders: state.orders.map(row => ({ ...row, window: copyWindow(row.window) })), shipments: state.shipments.map(row => ({ ...row, window: copyWindow(row.window) })), labels: state.labels.map(row => ({ ...row, window: copyWindow(row.window) })), notices: state.notices.map(row => ({ ...row, window: copyWindow(row.window) })) };
}
