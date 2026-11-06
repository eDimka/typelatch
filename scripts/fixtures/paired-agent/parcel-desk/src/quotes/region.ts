import type { ShippingRates } from "./types.js";
export const regionBase = (region: string, rates: ShippingRates): number => rates.baseByRegion[region] || rates.baseByRegion["*"] || 0;
