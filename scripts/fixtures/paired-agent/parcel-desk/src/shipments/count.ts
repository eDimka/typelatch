import type { ShipmentRecord } from "./types.js";
export const plannedShipmentCount = (shipments: readonly ShipmentRecord[]): number => shipments.filter(shipment => shipment.state === "planned").length;
