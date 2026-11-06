
import { Checkout, manifestSchema, importManifest, DeliveryBook } from "./dist/index.js";
import type { Product, Catalog, CartLine, Cart, ShippingRates, Quote, PartnerParcel, PartnerManifest, ManifestResult, DeliveryWindow, Address, OrderRecord, ShipmentRecord, LabelRecord, NoticeRecord, DeliveryState } from "./dist/index.js";
import type { Schema } from "effect";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Same<A extends true> = A;
type Checks = [
  Same<Equal<keyof typeof import("./dist/index.js"), "Checkout" | "manifestSchema" | "importManifest" | "DeliveryBook">>,
  Same<Equal<Product, { sku: string; title: string; unitGrams: number; unitCents: number }>>,
  Same<Equal<Catalog, Readonly<Record<string, Product>>>>,
  Same<Equal<CartLine, { sku: string; quantity: number }>>,
  Same<Equal<Cart, { lines: readonly CartLine[]; region: string }>>,
  Same<Equal<ShippingRates, { baseByRegion: Readonly<Record<string, number>>; perStartedKilogram: number }>>,
  Same<Equal<Quote, { merchandiseCents: number; shippingCents: number; totalCents: number; grams: number }>>,
  Same<Equal<ConstructorParameters<typeof Checkout>, [catalog: Catalog, rates: ShippingRates]>>,
  Same<Equal<keyof Checkout, "preview">>,
  Same<Equal<Checkout["preview"], (cart: Cart) => Quote>>,
  Same<Equal<PartnerParcel, { reference: string; grams: number; service: "standard" | "express" }>>,
  Same<Equal<PartnerManifest, { partner: string; parcels: readonly PartnerParcel[] }>>,
  Same<Equal<ManifestResult, { ok: true; manifest: PartnerManifest } | { ok: false; reason: "invalid-manifest" }>>,
  Same<Equal<typeof manifestSchema, Schema.Schema<PartnerManifest, unknown>>>,
  Same<Equal<typeof importManifest, (input: unknown) => ManifestResult>>,
  Same<Equal<DeliveryWindow, { from: string; to: string }>>,
  Same<Equal<Address, { region: string; postalCode: string }>>,
  Same<Equal<OrderRecord, { id: string; state: "open" | "closed"; window: DeliveryWindow }>>,
  Same<Equal<ShipmentRecord, { id: string; orderId: string; state: "planned" | "departed" | "cancelled"; window: DeliveryWindow }>>,
  Same<Equal<LabelRecord, { id: string; shipmentId: string; state: "queued" | "printed"; window: DeliveryWindow }>>,
  Same<Equal<NoticeRecord, { id: string; orderId: string; state: "queued" | "sent"; kind: "delivery" | "receipt"; window: DeliveryWindow }>>,
  Same<Equal<DeliveryState, { orders: OrderRecord[]; shipments: ShipmentRecord[]; labels: LabelRecord[]; notices: NoticeRecord[] }>>,
  Same<Equal<ConstructorParameters<typeof DeliveryBook>, [initial: DeliveryState]>>,
  Same<Equal<keyof DeliveryBook, "reschedule" | "snapshot">>,
  Same<Equal<DeliveryBook["reschedule"], (orderId: string, window: DeliveryWindow) => boolean>>,
  Same<Equal<DeliveryBook["snapshot"], () => DeliveryState>>
];
