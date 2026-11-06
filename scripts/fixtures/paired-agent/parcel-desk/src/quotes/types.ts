export type ShippingRates = { baseByRegion: Readonly<Record<string, number>>; perStartedKilogram: number };
export type Quote = { merchandiseCents: number; shippingCents: number; totalCents: number; grams: number };
