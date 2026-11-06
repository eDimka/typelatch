import { Either, Schema } from "effect";
import { manifestSchema } from "./schema.js";
import type { ManifestResult } from "./types.js";
export function importManifest(input: unknown): ManifestResult {
  const decoded = Schema.decodeUnknownEither(manifestSchema)(input);
  return Either.isRight(decoded) ? { ok: true, manifest: decoded.right } : { ok: false, reason: "invalid-manifest" };
}
