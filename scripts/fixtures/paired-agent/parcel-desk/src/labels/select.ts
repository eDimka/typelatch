import type { LabelRecord } from "./types.js";
export const labelsForShipment = (labels: LabelRecord[], shipmentId: string): LabelRecord[] => labels.filter(label => label.shipmentId === shipmentId);
