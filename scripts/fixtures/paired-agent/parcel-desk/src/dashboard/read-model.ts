import type { DeliveryState } from "../delivery/types.js";
import type { DeliveryWindow } from "../shared/types.js";
import type { DispatchPlan } from "../dispatch/planner.js";
import type { StockSnapshot } from "../dispatch/stock-ledger.js";
import { copyWindow } from "../shared/copy.js";

export type OrderTile = {
  orderId: string;
  state: "open" | "closed";
  window: DeliveryWindow;
  planned: number;
  departed: number;
  cancelled: number;
  queuedLabels: number;
  printedLabels: number;
  queuedNotices: number;
  sentNotices: number;
  attention: string[];
};
export type DashboardFilter = { query?: string; state?: "open" | "closed"; attentionOnly?: boolean; from?: string; to?: string };
export type DashboardPage = { rows: OrderTile[]; total: number; offset: number; nextOffset: number | null };
export type FulfillmentTotals = { orders: number; openOrders: number; shipments: number; departedShipments: number; queuedLabels: number; queuedNotices: number; inconsistentOrders: number };
export type IntegrityIssue = { kind: "duplicate" | "orphan" | "window"; collection: string; id: string; detail: string };

function sameWindow(left: DeliveryWindow, right: DeliveryWindow): boolean {
  return left.from === right.from && left.to === right.to;
}

export function orderTiles(state: DeliveryState): OrderTile[] {
  return state.orders.map(order => {
    const shipments = state.shipments.filter(shipment => shipment.orderId === order.id);
    const shipmentIds = new Set(shipments.map(shipment => shipment.id));
    const labels = state.labels.filter(label => shipmentIds.has(label.shipmentId));
    const notices = state.notices.filter(notice => notice.orderId === order.id);
    const attention: string[] = [];
    if (order.state === "open" && shipments.length === 0) attention.push("no-shipments");
    if (shipments.some(shipment => shipment.state === "planned" && !sameWindow(shipment.window, order.window))) attention.push("shipment-window");
    const planned = new Map(shipments.filter(shipment => shipment.state === "planned").map(shipment => [shipment.id, shipment]));
    if (labels.some(label => {
      const shipment = planned.get(label.shipmentId);
      return shipment !== undefined && label.state === "queued" && !sameWindow(label.window, shipment.window);
    })) attention.push("label-window");
    if (notices.some(notice => notice.state === "queued" && notice.kind === "delivery" && !sameWindow(notice.window, order.window))) attention.push("notice-window");
    return {
      orderId: order.id,
      state: order.state,
      window: copyWindow(order.window),
      planned: shipments.filter(shipment => shipment.state === "planned").length,
      departed: shipments.filter(shipment => shipment.state === "departed").length,
      cancelled: shipments.filter(shipment => shipment.state === "cancelled").length,
      queuedLabels: labels.filter(label => label.state === "queued").length,
      printedLabels: labels.filter(label => label.state === "printed").length,
      queuedNotices: notices.filter(notice => notice.state === "queued").length,
      sentNotices: notices.filter(notice => notice.state === "sent").length,
      attention,
    };
  });
}

export function dashboardPage(state: DeliveryState, filter: DashboardFilter = {}, offset = 0, limit = 25): DashboardPage {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid dashboard page");
  const query = (filter.query ?? "").trim().toLowerCase();
  const rows = orderTiles(state).filter(row => {
    if (query && !row.orderId.toLowerCase().includes(query)) return false;
    if (filter.state !== undefined && row.state !== filter.state) return false;
    if (filter.attentionOnly && row.attention.length === 0) return false;
    if (filter.from !== undefined && row.window.to < filter.from) return false;
    if (filter.to !== undefined && row.window.from > filter.to) return false;
    return true;
  }).sort((left, right) => left.window.from.localeCompare(right.window.from) || left.orderId.localeCompare(right.orderId));
  const selected = rows.slice(offset, offset + limit);
  return { rows: selected, total: rows.length, offset, nextOffset: offset + selected.length < rows.length ? offset + selected.length : null };
}

export function fulfillmentTotals(state: DeliveryState): FulfillmentTotals {
  return {
    orders: state.orders.length,
    openOrders: state.orders.filter(order => order.state === "open").length,
    shipments: state.shipments.length,
    departedShipments: state.shipments.filter(shipment => shipment.state === "departed").length,
    queuedLabels: state.labels.filter(label => label.state === "queued").length,
    queuedNotices: state.notices.filter(notice => notice.state === "queued").length,
    inconsistentOrders: orderTiles(state).filter(tile => tile.attention.length > 0).length,
  };
}

export function inspectDeliveryIntegrity(state: DeliveryState): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const orders = new Map(state.orders.map(order => [order.id, order]));
  const shipments = new Map(state.shipments.map(shipment => [shipment.id, shipment]));
  const collections = { orders: state.orders, shipments: state.shipments, labels: state.labels, notices: state.notices };
  for (const [collection, rows] of Object.entries(collections)) {
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.id)) issues.push({ kind: "duplicate", collection, id: row.id, detail: "Repeated record identity" });
      seen.add(row.id);
      if (!row.window.from || !row.window.to || row.window.from >= row.window.to) issues.push({ kind: "window", collection, id: row.id, detail: "Invalid delivery window" });
    }
  }
  for (const shipment of state.shipments) if (!orders.has(shipment.orderId)) issues.push({ kind: "orphan", collection: "shipments", id: shipment.id, detail: shipment.orderId });
  for (const label of state.labels) if (!shipments.has(label.shipmentId)) issues.push({ kind: "orphan", collection: "labels", id: label.id, detail: label.shipmentId });
  for (const notice of state.notices) if (!orders.has(notice.orderId)) issues.push({ kind: "orphan", collection: "notices", id: notice.id, detail: notice.orderId });
  return issues;
}

export function stockDashboard(snapshot: StockSnapshot): { sku: string; onHand: number; held: number; available: number; locations: string[] }[] {
  const rows = new Map<string, { sku: string; onHand: number; held: number; locations: Set<string> }>();
  for (const lot of snapshot.lots) {
    let row = rows.get(lot.sku);
    if (!row) { row = { sku: lot.sku, onHand: 0, held: 0, locations: new Set() }; rows.set(lot.sku, row); }
    row.onHand += lot.quantity;
    row.locations.add(lot.locationId);
  }
  for (const reservation of snapshot.reservations) {
    if (reservation.state !== "held") continue;
    for (const allocation of reservation.allocations) {
      const row = rows.get(allocation.sku);
      if (row) row.held += allocation.quantity;
    }
  }
  return [...rows.values()].map(row => ({ sku: row.sku, onHand: row.onHand, held: row.held, available: row.onHand - row.held, locations: [...row.locations].sort() })).sort((left, right) => left.sku.localeCompare(right.sku));
}

export function carrierSpend(plans: readonly DispatchPlan[]): { carrier: string; parcels: number; cents: number }[] {
  const carriers = new Map<string, { carrier: string; parcels: number; cents: number }>();
  for (const plan of plans) {
    if (plan.state !== "committed") continue;
    for (const parcel of plan.parcels) {
      let row = carriers.get(parcel.offer.carrier);
      if (!row) { row = { carrier: parcel.offer.carrier, parcels: 0, cents: 0 }; carriers.set(row.carrier, row); }
      row.parcels += 1;
      row.cents += parcel.offer.totalCents;
    }
  }
  return [...carriers.values()].sort((left, right) => right.cents - left.cents || left.carrier.localeCompare(right.carrier));
}
