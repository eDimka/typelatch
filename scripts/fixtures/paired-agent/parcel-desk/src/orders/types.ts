import type { DeliveryWindow } from "../shared/types.js";
export type OrderRecord = { id: string; state: "open" | "closed"; window: DeliveryWindow };
