import type { DeliveryWindow } from "../shared/types.js";
export const isValidWindow = (window: DeliveryWindow): boolean => window.from.length > 0 && window.to.length > 0 && window.from < window.to;
