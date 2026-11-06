import type { PartnerManifest } from "./types.js";
export const manifestReceipt = (manifest: PartnerManifest): string => `${manifest.partner}: ${manifest.parcels.length} parcels`;
