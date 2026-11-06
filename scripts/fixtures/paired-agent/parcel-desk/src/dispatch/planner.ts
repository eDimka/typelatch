import type { Cart } from "../cart/types.js";
import type { Catalog } from "../catalog/types.js";
import { requireProduct } from "../catalog/read.js";
import { copyCatalog } from "../catalog/service.js";
import { assertCart } from "../cart/validate.js";
import type { DeliveryWindow } from "../shared/types.js";
import { copyWindow } from "../shared/copy.js";
import type { DeliveryState } from "../delivery/types.js";
import { copyState } from "../delivery/copy.js";
import { isValidWindow } from "../delivery/window.js";
import { importManifest } from "../partners/decode.js";
import type { PartnerParcel } from "../partners/types.js";
import { RateBook, type RateOffer } from "../quotes/rate-book.js";
import { StockLedger, type StockAllocation, type Reservation } from "./stock-ledger.js";

export type DispatchOrder = { id: string; manifestReference: string; cart: Cart; postalCode: string; window: DeliveryWindow };
export type DispatchParcel = { id: string; orderId: string; locationId: string; grams: number; items: { sku: string; quantity: number }[]; offer: RateOffer };
export type DispatchPlan = { id: string; partner: string; createdAt: string; state: "prepared" | "committed" | "cancelled"; orderIds: string[]; reservationIds: string[]; parcels: DispatchParcel[]; shippingCents: number; delivery: DeliveryState };
export type DispatchEvent = { sequence: number; planId: string; kind: "prepared" | "committed" | "cancelled"; orderIds: string[] };
export type DispatchIssue = { orderId: string; code: "manifest-reference" | "weight-mismatch" | "duplicate-order" | "empty-cart"; message: string };
export type DispatchValidation = { valid: boolean; issues: DispatchIssue[] };

function copyParcel(parcel: DispatchParcel): DispatchParcel {
  return { ...parcel, items: parcel.items.map(item => ({ ...item })), offer: { ...parcel.offer } };
}

function copyPlan(plan: DispatchPlan): DispatchPlan {
  return { ...plan, orderIds: [...plan.orderIds], reservationIds: [...plan.reservationIds], parcels: plan.parcels.map(copyParcel), delivery: copyState(plan.delivery) };
}

function allocationGroups(allocations: readonly StockAllocation[]): Map<string, Map<string, number>> {
  const groups = new Map<string, Map<string, number>>();
  for (const allocation of allocations) {
    let items = groups.get(allocation.locationId);
    if (!items) {
      items = new Map();
      groups.set(allocation.locationId, items);
    }
    items.set(allocation.sku, (items.get(allocation.sku) ?? 0) + allocation.quantity);
  }
  return groups;
}

function orderWeight(order: DispatchOrder, catalog: Catalog): number {
  return order.cart.lines.reduce((total, line) => total + requireProduct(catalog, line.sku).unitGrams * line.quantity, 0);
}

export class DispatchPlanner {
  private readonly catalog: Catalog;
  private readonly plans = new Map<string, DispatchPlan>();
  private readonly events: DispatchEvent[] = [];
  constructor(catalog: Catalog, private readonly rates: RateBook, private readonly stock: StockLedger) {
    this.catalog = copyCatalog(catalog);
  }

  validate(orders: readonly DispatchOrder[], parcels: readonly PartnerParcel[]): DispatchValidation {
    const issues: DispatchIssue[] = [];
    const references = new Map(parcels.map(parcel => [parcel.reference, parcel]));
    const seen = new Set<string>();
    for (const order of orders) {
      if (!order.id || seen.has(order.id)) issues.push({ orderId: order.id, code: "duplicate-order", message: "Order identity must be unique and nonempty" });
      seen.add(order.id);
      assertCart(order.cart);
      if (!isValidWindow(order.window)) throw new Error("Invalid dispatch window");
      if (!order.cart.lines.length) issues.push({ orderId: order.id, code: "empty-cart", message: "Dispatch requires at least one item" });
      const parcel = references.get(order.manifestReference);
      if (!parcel) issues.push({ orderId: order.id, code: "manifest-reference", message: "Order does not identify a manifest parcel" });
      else if (parcel.grams !== orderWeight(order, this.catalog)) issues.push({ orderId: order.id, code: "weight-mismatch", message: "Manifest weight does not match merchandise" });
    }
    return { valid: issues.length === 0, issues };
  }

  prepare(id: string, manifestInput: unknown, orders: readonly DispatchOrder[], at: string): DispatchPlan {
    if (!id || !at || this.plans.has(id)) throw new Error("Dispatch plan identity must be new and nonempty");
    if (!orders.length) throw new Error("Dispatch requires orders");
    const imported = importManifest(manifestInput);
    if (!imported.ok) throw new Error("Invalid partner manifest");
    const validation = this.validate(orders, imported.manifest.parcels);
    if (!validation.valid) throw new Error(`Invalid dispatch orders: ${validation.issues.map(issue => issue.code).join(", ")}`);
    const references = new Map(imported.manifest.parcels.map(parcel => [parcel.reference, parcel]));
    const reservations: Reservation[] = [];
    const parcels: DispatchParcel[] = [];
    const delivery: DeliveryState = { orders: [], shipments: [], labels: [], notices: [] };
    try {
      for (const order of orders) {
        const manifestParcel = references.get(order.manifestReference);
        if (!manifestParcel) throw new Error("Manifest validation invariant failed");
        const reservation = this.stock.reserve(`${id}/${order.id}`, order.id, order.cart.lines, order.cart.region, at);
        reservations.push(reservation);
        const groups = allocationGroups(reservation.allocations);
        for (const [locationId, items] of groups) {
          const parcelId = `${id}/${order.id}/${locationId}`;
          const parcelItems = [...items].map(([sku, quantity]) => ({ sku, quantity }));
          const grams = parcelItems.reduce((total, item) => total + requireProduct(this.catalog, item.sku).unitGrams * item.quantity, 0);
          const offer = this.rates.best({ region: order.cart.region, postalCode: order.postalCode, grams, service: manifestParcel.service, date: at, remote: false });
          if (!offer) throw new Error(`No carrier service for order: ${order.id}`);
          parcels.push({ id: parcelId, orderId: order.id, locationId, grams, items: parcelItems, offer });
          delivery.shipments.push({ id: parcelId, orderId: order.id, state: "planned", window: copyWindow(order.window) });
          delivery.labels.push({ id: `label/${parcelId}`, shipmentId: parcelId, state: "queued", window: copyWindow(order.window) });
        }
        delivery.orders.push({ id: order.id, state: "open", window: copyWindow(order.window) });
        delivery.notices.push({ id: `notice/${id}/${order.id}`, orderId: order.id, state: "queued", kind: "delivery", window: copyWindow(order.window) });
      }
    } catch (error) {
      for (const reservation of reservations) this.stock.release(reservation.id);
      throw error;
    }
    const plan: DispatchPlan = { id, partner: imported.manifest.partner, createdAt: at, state: "prepared", orderIds: orders.map(order => order.id), reservationIds: reservations.map(reservation => reservation.id), parcels, shippingCents: parcels.reduce((total, parcel) => total + parcel.offer.totalCents, 0), delivery };
    this.plans.set(id, plan);
    this.record(plan, "prepared");
    return copyPlan(plan);
  }

  commit(id: string): DispatchPlan {
    const plan = this.requirePlan(id);
    if (plan.state === "committed") return copyPlan(plan);
    if (plan.state === "cancelled") throw new Error("Cancelled dispatch cannot be committed");
    for (const reservationId of plan.reservationIds) this.stock.commit(reservationId);
    for (const shipment of plan.delivery.shipments) shipment.state = "departed";
    for (const label of plan.delivery.labels) label.state = "printed";
    for (const notice of plan.delivery.notices) notice.state = "sent";
    for (const order of plan.delivery.orders) order.state = "closed";
    plan.state = "committed";
    this.record(plan, "committed");
    return copyPlan(plan);
  }

  cancel(id: string): DispatchPlan {
    const plan = this.requirePlan(id);
    if (plan.state === "cancelled") return copyPlan(plan);
    if (plan.state === "committed") throw new Error("Committed dispatch cannot be cancelled");
    for (const reservationId of plan.reservationIds) this.stock.release(reservationId);
    for (const shipment of plan.delivery.shipments) shipment.state = "cancelled";
    for (const order of plan.delivery.orders) order.state = "closed";
    plan.state = "cancelled";
    this.record(plan, "cancelled");
    return copyPlan(plan);
  }

  get(id: string): DispatchPlan | null {
    const plan = this.plans.get(id);
    return plan ? copyPlan(plan) : null;
  }

  forOrder(orderId: string): DispatchPlan[] {
    return [...this.plans.values()].filter(plan => plan.orderIds.includes(orderId)).map(copyPlan);
  }

  history(afterSequence = 0): DispatchEvent[] {
    return this.events.filter(event => event.sequence > afterSequence).map(event => ({ ...event, orderIds: [...event.orderIds] }));
  }

  totals(): { prepared: number; committed: number; cancelled: number; committedShippingCents: number } {
    const plans = [...this.plans.values()];
    return { prepared: plans.filter(plan => plan.state === "prepared").length, committed: plans.filter(plan => plan.state === "committed").length, cancelled: plans.filter(plan => plan.state === "cancelled").length, committedShippingCents: plans.filter(plan => plan.state === "committed").reduce((total, plan) => total + plan.shippingCents, 0) };
  }

  private requirePlan(id: string): DispatchPlan {
    const plan = this.plans.get(id);
    if (!plan) throw new Error(`Unknown dispatch plan: ${id}`);
    return plan;
  }

  private record(plan: DispatchPlan, kind: DispatchEvent["kind"]): void {
    this.events.push({ sequence: this.events.length + 1, planId: plan.id, kind, orderIds: [...plan.orderIds] });
  }
}
