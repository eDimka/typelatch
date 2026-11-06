import type { DeliveryWindow } from "../shared/types.js";
export type ShipmentRecord = { id: string; orderId: string; state: "planned" | "departed" | "cancelled"; window: DeliveryWindow };
