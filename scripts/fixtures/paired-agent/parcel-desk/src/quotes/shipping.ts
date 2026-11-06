import type { ShippingRates } from "./types.js";
import { regionBase } from "./region.js";
export const shippingTotal = (grams: number, region: string, rates: ShippingRates): number => grams === 0 ? 0 : regionBase(region, rates) + Math.ceil(grams / 1000) * rates.perStartedKilogram;
