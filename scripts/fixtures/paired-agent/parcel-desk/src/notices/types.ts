import type { DeliveryWindow } from "../shared/types.js";
export type NoticeRecord = { id: string; orderId: string; state: "queued" | "sent"; kind: "delivery" | "receipt"; window: DeliveryWindow };
