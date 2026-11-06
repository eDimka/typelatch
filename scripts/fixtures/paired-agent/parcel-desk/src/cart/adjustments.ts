import type { Catalog } from "../catalog/types.js";
import { requireProduct } from "../catalog/read.js";
import type { Cart } from "./types.js";
import { assertCart } from "./validate.js";

export type CartAdjustment = {
  id: string;
  kind: "fixed" | "percent" | "buy-more";
  amount: number;
  minimumSubtotal: number;
  eligibleSkus: readonly string[];
  minimumUnits: number;
  exclusiveGroup: string | null;
  stackable: boolean;
};
export type AdjustmentLine = { sku: string; quantity: number; grossCents: number; discountCents: number; netCents: number };
export type AppliedAdjustment = { id: string; cents: number; lineCents: number[] };
export type AdjustmentResult = { lines: AdjustmentLine[]; grossCents: number; discountCents: number; netCents: number; applied: AppliedAdjustment[]; rejected: { id: string; reason: string }[] };
export type TaxRule = { region: string; basisPoints: number; inclusive: boolean };
export type TaxSummary = { netCents: number; taxCents: number; grossCents: number; basisPoints: number };

function natural(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateAdjustment(adjustment: CartAdjustment): void {
  if (!adjustment.id) throw new Error("Adjustment identity is required");
  if (!natural(adjustment.amount) || !natural(adjustment.minimumSubtotal) || !natural(adjustment.minimumUnits)) throw new Error("Adjustment values must be nonnegative integers");
  if (adjustment.kind === "percent" && adjustment.amount > 10000) throw new Error("Percentage exceeds full price");
  if (!["fixed", "percent", "buy-more"].includes(adjustment.kind)) throw new Error("Unknown adjustment kind");
}

export function allocateCents(total: number, weights: readonly number[]): number[] {
  if (!natural(total) || weights.some(weight => !natural(weight))) throw new Error("Allocation requires nonnegative integers");
  if (weights.length === 0) {
    if (total !== 0) throw new Error("Cannot allocate money to an empty list");
    return [];
  }
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (sum === 0) {
    if (total !== 0) throw new Error("Cannot allocate money to zero weights");
    return weights.map(() => 0);
  }
  const shares = weights.map(weight => Math.floor(total * weight / sum));
  let remainder = total - shares.reduce((value, share) => value + share, 0);
  const order = weights.map((weight, index) => ({ index, remainder: total * weight % sum })).sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const item of order) {
    if (remainder === 0) break;
    shares[item.index] = (shares[item.index] ?? 0) + 1;
    remainder -= 1;
  }
  return shares;
}

export function applyCartAdjustments(cart: Cart, catalog: Catalog, adjustments: readonly CartAdjustment[]): AdjustmentResult {
  assertCart(cart);
  const lines: AdjustmentLine[] = cart.lines.map(line => {
    const grossCents = requireProduct(catalog, line.sku).unitCents * line.quantity;
    if (!natural(grossCents)) throw new Error("Invalid merchandise amount");
    return { sku: line.sku, quantity: line.quantity, grossCents, discountCents: 0, netCents: grossCents };
  });
  const grossCents = lines.reduce((total, line) => total + line.grossCents, 0);
  const result: AdjustmentResult = { lines, grossCents, discountCents: 0, netCents: grossCents, applied: [], rejected: [] };
  const seen = new Set<string>();
  const groups = new Set<string>();
  let exclusiveApplied = false;
  for (const adjustment of adjustments) {
    validateAdjustment(adjustment);
    if (seen.has(adjustment.id)) throw new Error("Duplicate adjustment identity");
    seen.add(adjustment.id);
    let reason: string | null = null;
    if (exclusiveApplied || (!adjustment.stackable && result.applied.length > 0)) reason = "not-stackable";
    else if (adjustment.exclusiveGroup !== null && groups.has(adjustment.exclusiveGroup)) reason = "exclusive-group";
    else if (grossCents < adjustment.minimumSubtotal) reason = "minimum-subtotal";
    const eligible = lines.map(line => adjustment.eligibleSkus.length === 0 || adjustment.eligibleSkus.includes(line.sku));
    const units = lines.reduce((total, line, index) => total + (eligible[index] ? line.quantity : 0), 0);
    if (reason === null && units < adjustment.minimumUnits) reason = "minimum-units";
    const weights = lines.map((line, index) => eligible[index] ? line.netCents : 0);
    const available = weights.reduce((total, value) => total + value, 0);
    if (reason === null && available === 0) reason = "no-eligible-value";
    if (reason !== null) {
      result.rejected.push({ id: adjustment.id, reason });
      continue;
    }
    const proposed = adjustment.kind === "percent"
      ? Math.floor(available * adjustment.amount / 10000)
      : adjustment.kind === "buy-more"
        ? adjustment.amount * Math.floor(units / Math.max(1, adjustment.minimumUnits))
        : adjustment.amount;
    const cents = Math.min(available, proposed);
    const lineCents = allocateCents(cents, weights);
    for (const [index, line] of lines.entries()) {
      const discount = lineCents[index] ?? 0;
      line.discountCents += discount;
      line.netCents -= discount;
    }
    result.applied.push({ id: adjustment.id, cents, lineCents });
    if (adjustment.exclusiveGroup !== null) groups.add(adjustment.exclusiveGroup);
    if (!adjustment.stackable) exclusiveApplied = true;
  }
  result.discountCents = result.applied.reduce((total, adjustment) => total + adjustment.cents, 0);
  result.netCents = grossCents - result.discountCents;
  return result;
}

export function calculateTax(cents: number, rule: TaxRule): TaxSummary {
  if (!natural(cents) || !natural(rule.basisPoints)) throw new Error("Tax requires nonnegative integer amounts");
  if (rule.inclusive) {
    const netCents = Math.round(cents * 10000 / (10000 + rule.basisPoints));
    return { netCents, taxCents: cents - netCents, grossCents: cents, basisPoints: rule.basisPoints };
  }
  const taxCents = Math.round(cents * rule.basisPoints / 10000);
  return { netCents: cents, taxCents, grossCents: cents + taxCents, basisPoints: rule.basisPoints };
}

export function taxRuleForRegion(region: string, rules: readonly TaxRule[]): TaxRule {
  const exact = rules.find(rule => rule.region === region);
  const fallback = rules.find(rule => rule.region === "*");
  return { ...(exact ?? fallback ?? { region, basisPoints: 0, inclusive: false }) };
}

export function adjustmentSummary(result: AdjustmentResult): string[] {
  return result.applied.map(adjustment => `${adjustment.id}: ${adjustment.cents}`).concat(result.rejected.map(adjustment => `${adjustment.id}: skipped (${adjustment.reason})`));
}

export function returnCredit(lines: readonly AdjustmentLine[], quantities: Readonly<Record<string, number>>): { sku: string; quantity: number; cents: number }[] {
  const remaining = new Map(Object.entries(quantities));
  for (const quantity of remaining.values()) if (!natural(quantity)) throw new Error("Invalid return quantity");
  const credits: { sku: string; quantity: number; cents: number }[] = [];
  for (const line of lines) {
    const requested = remaining.get(line.sku) ?? 0;
    const quantity = Math.min(line.quantity, requested);
    if (!quantity) continue;
    const cents = quantity === line.quantity ? line.netCents : Math.floor(line.netCents * quantity / line.quantity);
    credits.push({ sku: line.sku, quantity, cents });
    remaining.set(line.sku, requested - quantity);
  }
  if ([...remaining.values()].some(quantity => quantity > 0)) throw new Error("Return exceeds purchased quantity");
  return credits;
}
