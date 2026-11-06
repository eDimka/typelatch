import type { DeliveryState } from "../delivery/types.js";
export const dashboardTiles = (state: DeliveryState): number[] => [state.orders.length, state.shipments.length, state.labels.length, state.notices.length];
