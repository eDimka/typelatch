import type { validateWorkspace } from "./validate.js"

export type ValidationEvidence = Awaited<ReturnType<typeof validateWorkspace>>
export type ValidationDetail = "compact" | "full"

function snapshotSummary<T extends { inputs: unknown[] }>(snapshot: T | null) {
  if (snapshot === null) return null
  const { inputs, ...identity } = snapshot
  return { ...identity, inputCount: inputs.length, inputsOmitted: inputs.length }
}

/** Project model output only; the full evidence and recording policy stay unchanged. */
export function validationOutput(evidence: ValidationEvidence, detail: ValidationDetail = "compact") {
  if (detail === "full") return evidence
  const { checks, execution, failure, success, snapshot, runtimeSnapshot, ...identity } = evidence
  return {
    detail: "compact" as const,
    success, checks, execution, failure,
    ...identity,
    snapshot: snapshotSummary(snapshot),
    runtimeSnapshot: snapshotSummary(runtimeSnapshot),
  }
}
