import type { DeliveryState } from "../delivery/types.js";
export const orphanLabels = (state: DeliveryState): string[] => state.labels.filter(label => !state.shipments.some(shipment => shipment.id === label.shipmentId)).map(label => label.id);
