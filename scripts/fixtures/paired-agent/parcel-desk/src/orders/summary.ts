import type { OrderRecord } from "./types.js";
export const openOrderCount = (orders: readonly OrderRecord[]): number => orders.filter(order => order.state === "open").length;
