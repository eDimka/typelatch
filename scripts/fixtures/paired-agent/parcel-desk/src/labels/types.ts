import type { DeliveryWindow } from "../shared/types.js";
export type LabelRecord = { id: string; shipmentId: string; state: "queued" | "printed"; window: DeliveryWindow };
