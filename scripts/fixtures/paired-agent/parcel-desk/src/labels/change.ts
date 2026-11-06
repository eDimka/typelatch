import type { LabelRecord } from "./types.js";
import type { DeliveryWindow } from "../shared/types.js";
import { copyWindow } from "../shared/copy.js";
export function changeLabelWindow(label: LabelRecord, window: DeliveryWindow): void { label.window = copyWindow(window); }
