import type { ShipmentRecord } from "./types.js";
import type { DeliveryWindow } from "../shared/types.js";
import { copyWindow } from "../shared/copy.js";
export function changeShipmentWindow(shipment: ShipmentRecord, window: DeliveryWindow): void { shipment.window = copyWindow(window); }
