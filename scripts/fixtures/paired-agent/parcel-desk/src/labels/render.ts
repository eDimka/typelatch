import type { LabelRecord } from "./types.js";
export const labelCaption = (label: LabelRecord): string => `${label.shipmentId}: ${label.window.from} to ${label.window.to}`;
