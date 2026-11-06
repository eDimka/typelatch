import type { OrderRecord } from "../orders/types.js";
import type { ShipmentRecord } from "../shipments/types.js";
import type { LabelRecord } from "../labels/types.js";
import type { NoticeRecord } from "../notices/types.js";
export type DeliveryState = { orders: OrderRecord[]; shipments: ShipmentRecord[]; labels: LabelRecord[]; notices: NoticeRecord[] };
