import type { ShippingRates } from "./types.js";
export const regionBase = (region: string, rates: ShippingRates): number => Object.hasOwn(rates.baseByRegion, region) ? rates.baseByRegion[region]! : Object.hasOwn(rates.baseByRegion, "*") ? rates.baseByRegion["*"]! : 0;
