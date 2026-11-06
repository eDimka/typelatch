import type { OrderRecord } from "./types.js";
export const findOrder = (orders: OrderRecord[], id: string): OrderRecord | undefined => orders.find(order => order.id === id);
