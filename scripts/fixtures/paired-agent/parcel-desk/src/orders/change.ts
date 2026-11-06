import type { OrderRecord } from "./types.js";
import type { DeliveryWindow } from "../shared/types.js";
import { copyWindow } from "../shared/copy.js";
export function changeOrderWindow(order: OrderRecord, window: DeliveryWindow): void { order.window = copyWindow(window); }
