import type { ShipmentRecord } from "./types.js";
export const shipmentsForOrder = (shipments: ShipmentRecord[], orderId: string): ShipmentRecord[] => shipments.filter(shipment => shipment.orderId === orderId);
