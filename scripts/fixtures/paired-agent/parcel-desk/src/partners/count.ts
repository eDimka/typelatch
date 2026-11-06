import type { PartnerManifest } from "./types.js";
export const manifestParcelCount = (manifest: PartnerManifest): number => manifest.parcels.length;
