import type { DeliveryWindow } from "./types.js";
export const copyWindow = (window: DeliveryWindow): DeliveryWindow => ({ from: window.from, to: window.to });
