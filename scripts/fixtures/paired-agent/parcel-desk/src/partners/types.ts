export type PartnerParcel = { reference: string; grams: number; service: "standard" | "express" };
export type PartnerManifest = { partner: string; parcels: readonly PartnerParcel[] };
export type ManifestResult = { ok: true; manifest: PartnerManifest } | { ok: false; reason: "invalid-manifest" };
