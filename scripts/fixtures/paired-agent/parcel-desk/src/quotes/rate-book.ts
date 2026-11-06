import type { ShippingRates } from "./types.js";

export type RateService = "standard" | "express";
export type RateBand = { throughGrams: number | null; cents: number };
export type RateCard = {
  id: string;
  carrier: string;
  service: RateService;
  regions: readonly string[];
  postalPrefixes: readonly string[];
  minGrams: number;
  maxGrams: number | null;
  bands: readonly RateBand[];
  fuelBasisPoints: number;
  remoteAreaCents: number;
  availableFrom: string;
  availableUntil: string | null;
  priority: number;
};
export type RateRequest = { region: string; postalCode: string; grams: number; service: RateService; date: string; remote: boolean };
export type RateOffer = { cardId: string; carrier: string; baseCents: number; fuelCents: number; remoteCents: number; totalCents: number; priority: number };
export type RateExplanation = { cardId: string; eligible: boolean; reasons: string[]; offer: RateOffer | null };
export type RateSummary = { cards: number; carriers: string[]; services: RateService[]; regions: string[] };

export function snapshotShippingRates(rates: ShippingRates): ShippingRates {
  return { perStartedKilogram: rates.perStartedKilogram, baseByRegion: { ...rates.baseByRegion } };
}

function copyCard(card: RateCard): RateCard {
  return { ...card, regions: [...card.regions], postalPrefixes: [...card.postalPrefixes], bands: card.bands.map(band => ({ ...band })) };
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateCard(card: RateCard): void {
  if (!card.id || !card.carrier) throw new Error("Rate card requires identity");
  if (card.service !== "standard" && card.service !== "express") throw new Error("Unknown rate service");
  if (!card.regions.length || card.regions.some(region => !region)) throw new Error("Rate card requires regions");
  if (!positiveInteger(card.minGrams)) throw new Error("Invalid minimum weight");
  if (card.maxGrams !== null && (!positiveInteger(card.maxGrams) || card.maxGrams < card.minGrams)) throw new Error("Invalid maximum weight");
  if (!positiveInteger(card.fuelBasisPoints) || !positiveInteger(card.remoteAreaCents)) throw new Error("Invalid surcharge");
  if (!Number.isSafeInteger(card.priority)) throw new Error("Invalid priority");
  if (!card.availableFrom || (card.availableUntil !== null && card.availableUntil <= card.availableFrom)) throw new Error("Invalid rate interval");
  if (!card.bands.length) throw new Error("Rate card requires weight bands");
  let previous = -1;
  for (const [index, band] of card.bands.entries()) {
    if (!positiveInteger(band.cents)) throw new Error("Invalid band price");
    if (band.throughGrams === null) {
      if (index !== card.bands.length - 1) throw new Error("Open band must be last");
    } else {
      if (!positiveInteger(band.throughGrams) || band.throughGrams <= previous) throw new Error("Weight bands must increase");
      previous = band.throughGrams;
    }
  }
}

function validateRequest(request: RateRequest): void {
  if (!request.region || !request.date) throw new Error("Rate request requires region and date");
  if (!positiveInteger(request.grams)) throw new Error("Rate request requires integer weight");
}

function eligibility(card: RateCard, request: RateRequest): string[] {
  const reasons: string[] = [];
  if (card.service !== request.service) reasons.push("service");
  if (!card.regions.includes("*") && !card.regions.includes(request.region)) reasons.push("region");
  if (card.postalPrefixes.length && !card.postalPrefixes.some(prefix => request.postalCode.startsWith(prefix))) reasons.push("postal-code");
  if (request.grams < card.minGrams || (card.maxGrams !== null && request.grams > card.maxGrams)) reasons.push("weight");
  if (request.date < card.availableFrom || (card.availableUntil !== null && request.date >= card.availableUntil)) reasons.push("date");
  if (!card.bands.some(band => band.throughGrams === null || request.grams <= band.throughGrams)) reasons.push("weight-band");
  return reasons;
}

function price(card: RateCard, request: RateRequest): RateOffer {
  const band = card.bands.find(item => item.throughGrams === null || request.grams <= item.throughGrams);
  if (!band) throw new Error("No eligible weight band");
  const fuelCents = Math.ceil(band.cents * card.fuelBasisPoints / 10000);
  const remoteCents = request.remote ? card.remoteAreaCents : 0;
  return { cardId: card.id, carrier: card.carrier, baseCents: band.cents, fuelCents, remoteCents, totalCents: band.cents + fuelCents + remoteCents, priority: card.priority };
}

function offerOrder(left: RateOffer, right: RateOffer): number {
  return left.totalCents - right.totalCents || right.priority - left.priority || left.carrier.localeCompare(right.carrier) || left.cardId.localeCompare(right.cardId);
}

export class RateBook {
  private cards: Map<string, RateCard>;
  constructor(cards: readonly RateCard[]) {
    this.cards = new Map();
    for (const card of cards) {
      validateCard(card);
      if (this.cards.has(card.id)) throw new Error(`Duplicate rate card: ${card.id}`);
      this.cards.set(card.id, copyCard(card));
    }
  }

  explain(request: RateRequest): RateExplanation[] {
    validateRequest(request);
    return [...this.cards.values()].map(card => {
      const reasons = eligibility(card, request);
      return { cardId: card.id, eligible: reasons.length === 0, reasons, offer: reasons.length === 0 ? price(card, request) : null };
    });
  }

  offers(request: RateRequest): RateOffer[] {
    return this.explain(request).flatMap(item => item.offer === null ? [] : [item.offer]).sort(offerOrder);
  }

  best(request: RateRequest): RateOffer | null {
    return this.offers(request)[0] ?? null;
  }

  replace(cards: readonly RateCard[]): void {
    const replacement = new RateBook(cards);
    this.cards = new Map(replacement.list().map(card => [card.id, card]));
  }

  list(): RateCard[] {
    return [...this.cards.values()].map(copyCard).sort((left, right) => left.id.localeCompare(right.id));
  }

  summary(): RateSummary {
    const cards = [...this.cards.values()];
    return { cards: cards.length, carriers: [...new Set(cards.map(card => card.carrier))].sort(), services: [...new Set(cards.map(card => card.service))].sort(), regions: [...new Set(cards.flatMap(card => card.regions))].sort() };
  }

  compare(requests: readonly RateRequest[]): { request: RateRequest; selected: RateOffer | null; alternatives: number }[] {
    return requests.map(request => {
      const offers = this.offers(request);
      return { request: { ...request }, selected: offers[0] ?? null, alternatives: Math.max(0, offers.length - 1) };
    });
  }
}

export function simpleRatesForRegion(cards: readonly { region: string; baseCents: number }[], perStartedKilogram: number): ShippingRates {
  if (!positiveInteger(perStartedKilogram)) throw new Error("Invalid per kilogram price");
  const baseByRegion: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const card of cards) {
    if (!card.region || !positiveInteger(card.baseCents)) throw new Error("Invalid regional tariff");
    if (Object.hasOwn(baseByRegion, card.region)) throw new Error("Duplicate regional tariff");
    baseByRegion[card.region] = card.baseCents;
  }
  return { baseByRegion, perStartedKilogram };
}
