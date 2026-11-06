import { Schema } from "effect";
export const previewParcel = Schema.Struct({ reference: Schema.String, mass: Schema.Number });
