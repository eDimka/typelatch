import { Schema } from "effect";
import type { PartnerManifest } from "./types.js";
const text = Schema.Trim.pipe(Schema.nonEmptyString());
const parcel = Schema.Struct({ reference: text, grams: Schema.Number.pipe(Schema.finite(), Schema.int(), Schema.positive()), service: Schema.Literal("standard", "express") });
const shape = Schema.Struct({ partner: text, parcels: Schema.Array(parcel).pipe(Schema.minItems(1)) }).pipe(Schema.filter(value => new Set(value.parcels.map(item => item.reference)).size === value.parcels.length));
export const manifestSchema: Schema.Schema<PartnerManifest, unknown> = Schema.compose(Schema.Unknown, shape, { strict: false });
