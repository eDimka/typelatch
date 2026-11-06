export type StockLocation = { id: string; priority: number; active: boolean; regions: readonly string[] };
export type StockLot = { id: string; sku: string; locationId: string; quantity: number; receivedAt: string; expiresAt: string | null };
export type StockRequest = { sku: string; quantity: number };
export type StockAllocation = { lotId: string; locationId: string; sku: string; quantity: number };
export type Reservation = { id: string; orderId: string; state: "held" | "committed" | "released"; allocations: StockAllocation[] };
export type StockEvent = { sequence: number; kind: "reserve" | "commit" | "release" | "restock"; reference: string; allocations: StockAllocation[] };
export type StockSnapshot = { lots: StockLot[]; reservations: Reservation[]; events: StockEvent[] };

const copyAllocation = (allocation: StockAllocation): StockAllocation => ({ ...allocation });
const copyReservation = (reservation: Reservation): Reservation => ({ ...reservation, allocations: reservation.allocations.map(copyAllocation) });
const copyEvent = (event: StockEvent): StockEvent => ({ ...event, allocations: event.allocations.map(copyAllocation) });
const natural = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export class StockLedger {
  private readonly locations: Map<string, StockLocation>;
  private readonly lots = new Map<string, StockLot>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly events: StockEvent[] = [];

  constructor(locations: readonly StockLocation[], lots: readonly StockLot[]) {
    this.locations = new Map();
    for (const location of locations) {
      if (!location.id || this.locations.has(location.id) || !Number.isSafeInteger(location.priority)) throw new Error("Invalid stock location");
      this.locations.set(location.id, { ...location, regions: [...location.regions] });
    }
    for (const lot of lots) {
      this.validateLot(lot);
      if (this.lots.has(lot.id)) throw new Error("Duplicate stock lot");
      this.lots.set(lot.id, { ...lot });
    }
  }

  private validateLot(lot: StockLot): void {
    if (!lot.id || !lot.sku || !this.locations.has(lot.locationId)) throw new Error("Invalid stock lot identity");
    if (!natural(lot.quantity)) throw new Error("Invalid stock quantity");
    if (!lot.receivedAt || (lot.expiresAt !== null && lot.expiresAt <= lot.receivedAt)) throw new Error("Invalid stock dates");
  }

  private heldForLot(lotId: string): number {
    let held = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.state !== "held") continue;
      for (const allocation of reservation.allocations) if (allocation.lotId === lotId) held += allocation.quantity;
    }
    return held;
  }

  private candidates(sku: string, region: string, at: string): StockLot[] {
    return [...this.lots.values()].filter(lot => {
      const location = this.locations.get(lot.locationId);
      return lot.sku === sku && location?.active === true && (location.regions.includes("*") || location.regions.includes(region)) && lot.receivedAt <= at && (lot.expiresAt === null || lot.expiresAt > at);
    }).sort((left, right) => {
      const leftExpiry = left.expiresAt ?? "\uffff", rightExpiry = right.expiresAt ?? "\uffff";
      const leftPriority = this.locations.get(left.locationId)?.priority ?? 0;
      const rightPriority = this.locations.get(right.locationId)?.priority ?? 0;
      return leftExpiry.localeCompare(rightExpiry) || rightPriority - leftPriority || left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id);
    });
  }

  availability(sku: string, region: string, at: string): { onHand: number; held: number; available: number } {
    const lots = this.candidates(sku, region, at);
    const onHand = lots.reduce((total, lot) => total + lot.quantity, 0);
    const held = lots.reduce((total, lot) => total + this.heldForLot(lot.id), 0);
    return { onHand, held, available: onHand - held };
  }

  reserve(id: string, orderId: string, requests: readonly StockRequest[], region: string, at: string): Reservation {
    if (!id || !orderId || !region || !at) throw new Error("Reservation requires identity and context");
    if (this.reservations.has(id)) throw new Error("Reservation identity already exists");
    const quantities = new Map<string, number>();
    for (const request of requests) {
      if (!request.sku || !natural(request.quantity) || request.quantity === 0) throw new Error("Invalid stock request");
      quantities.set(request.sku, (quantities.get(request.sku) ?? 0) + request.quantity);
    }
    const allocations: StockAllocation[] = [];
    for (const [sku, quantity] of quantities) {
      let remaining = quantity;
      for (const lot of this.candidates(sku, region, at)) {
        const available = lot.quantity - this.heldForLot(lot.id);
        const selected = Math.min(available, remaining);
        if (selected > 0) allocations.push({ lotId: lot.id, locationId: lot.locationId, sku, quantity: selected });
        remaining -= selected;
        if (remaining === 0) break;
      }
      if (remaining > 0) throw new Error(`Insufficient stock: ${sku}`);
    }
    const reservation: Reservation = { id, orderId, state: "held", allocations };
    this.reservations.set(id, reservation);
    this.record("reserve", id, allocations);
    return copyReservation(reservation);
  }

  commit(id: string): Reservation {
    const reservation = this.requireReservation(id);
    if (reservation.state === "committed") return copyReservation(reservation);
    if (reservation.state === "released") throw new Error("Released stock cannot be committed");
    for (const allocation of reservation.allocations) {
      const lot = this.lots.get(allocation.lotId);
      if (!lot || lot.quantity < allocation.quantity) throw new Error("Reservation stock invariant failed");
    }
    for (const allocation of reservation.allocations) {
      const lot = this.lots.get(allocation.lotId);
      if (lot) lot.quantity -= allocation.quantity;
    }
    reservation.state = "committed";
    this.record("commit", id, reservation.allocations);
    return copyReservation(reservation);
  }

  release(id: string): Reservation {
    const reservation = this.requireReservation(id);
    if (reservation.state === "released") return copyReservation(reservation);
    if (reservation.state === "committed") throw new Error("Committed stock cannot be released");
    reservation.state = "released";
    this.record("release", id, reservation.allocations);
    return copyReservation(reservation);
  }

  restock(lot: StockLot): void {
    this.validateLot(lot);
    const existing = this.lots.get(lot.id);
    if (existing && (existing.sku !== lot.sku || existing.locationId !== lot.locationId || existing.receivedAt !== lot.receivedAt || existing.expiresAt !== lot.expiresAt)) throw new Error("Stock lot identity changed");
    this.lots.set(lot.id, existing ? { ...existing, quantity: existing.quantity + lot.quantity } : { ...lot });
    this.record("restock", lot.id, [{ lotId: lot.id, locationId: lot.locationId, sku: lot.sku, quantity: lot.quantity }]);
  }

  forOrder(orderId: string): Reservation[] {
    return [...this.reservations.values()].filter(reservation => reservation.orderId === orderId).map(copyReservation);
  }

  snapshot(): StockSnapshot {
    return { lots: [...this.lots.values()].map(lot => ({ ...lot })), reservations: [...this.reservations.values()].map(copyReservation), events: this.events.map(copyEvent) };
  }

  eventsAfter(sequence: number): StockEvent[] {
    return this.events.filter(event => event.sequence > sequence).map(copyEvent);
  }

  private requireReservation(id: string): Reservation {
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error(`Unknown reservation: ${id}`);
    return reservation;
  }

  private record(kind: StockEvent["kind"], reference: string, allocations: readonly StockAllocation[]): void {
    this.events.push({ sequence: this.events.length + 1, kind, reference, allocations: allocations.map(copyAllocation) });
  }
}
