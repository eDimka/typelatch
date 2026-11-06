import type { DeliveryState } from "./types.js";
import { openOrderCount } from "../orders/summary.js";
import { plannedShipmentCount } from "../shipments/count.js";
export const deliveryReport = (state: DeliveryState): string => `${openOrderCount(state.orders)} open, ${plannedShipmentCount(state.shipments)} planned`;
