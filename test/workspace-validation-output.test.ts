import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { validationOutput, type ValidationEvidence } from "../src/workspace/validation-output.js"
import { validationSchema } from "../src/workspace/schema.js"

const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function evidence(inputCount = 436): ValidationEvidence {
  const inputs = Array.from({ length: inputCount }, (_, index) => ({ file: `/workspace/node_modules/dependency-${index}/dist/declarations/index.d.ts`, sha256: hash(`input-${index}`) }))
  const runtimeInputs = [{ file: "/workspace/batch.ts", sha256: hash("batch") }, { file: "/workspace/batch.test.ts", sha256: hash("test") }]
  const snapshotId = hash(JSON.stringify(inputs))
  const runtimeId = hash(JSON.stringify(runtimeInputs))
  return {
    schemaVersion: 2, id: "00000000-0000-4000-8000-000000000001", queryId: null, origin: "tool-executed",
    createdAt: "2026-11-06T00:00:00.000Z",
    snapshot: { id: snapshotId, config: "/workspace/tsconfig.json", compiler: { version: "6.0.3", path: "/workspace/node_modules/typescript/lib/typescript.js" }, scope: "Compiler-read inputs and configuration; not a full runtime filesystem snapshot", overlayFiles: [], inputs },
    runtimeSnapshot: { id: runtimeId, root: "/workspace", bytes: 400, files: runtimeInputs.length, excluded: ["node_modules"], extraInputs: [], scope: "Local fixture inputs only", inputs: runtimeInputs },
    afterSnapshotId: snapshotId, afterRuntimeSnapshotId: runtimeId, environmentHash: hash("environment"),
    checks: {
      typechecked: { status: "pass", reason: "Compiler completed", diagnostics: [] },
      tested: { status: "fail", reason: "Explicit assertion command failed" },
      stable: { status: "pass", reason: "Input snapshots match" },
    },
    execution: { command: ["npm", "test"], cwd: "/workspace", exitCode: 1, signal: null, status: "fail", timedOut: false, outputLimitExceeded: false, cancelled: false, stdout: "not ok 1 - duplicate contact rolls back\nexpected: 0\nactual: 1\n", stderr: "AssertionError: duplicate contact was retained", durationMs: 200 },
    failure: null, success: false, durationMs: 800, evidencePath: null,
  }
}

it("keeps outcomes and full test failures visible without returning hundreds of manifest rows", () => {
  // The recorded SQLite calls contained 436 compiler input rows each.
  const full = evidence()
  const before = structuredClone(full)
  const compact = validationOutput(full)
  expect(bytes(full)).toBeGreaterThan(65_000)
  expect(bytes(compact)).toBeLessThan(5_000)
  expect(compact).toMatchObject({ detail: "compact", success: false, evidencePath: null, checks: full.checks, execution: full.execution,
    snapshot: { id: full.snapshot!.id, compiler: full.snapshot!.compiler, inputCount: 436, inputsOmitted: 436 },
    runtimeSnapshot: { id: full.runtimeSnapshot!.id, scope: full.runtimeSnapshot!.scope, inputCount: 2, inputsOmitted: 2 },
    afterSnapshotId: full.afterSnapshotId, afterRuntimeSnapshotId: full.afterRuntimeSnapshotId,
  })
  expect(compact.snapshot).not.toHaveProperty("inputs")
  expect(compact.runtimeSnapshot).not.toHaveProperty("inputs")
  expect(Object.keys(compact).indexOf("checks")).toBeLessThan(Object.keys(compact).indexOf("snapshot"))
  expect(full).toEqual(before)
})

it("preserves failed, unknown and missing evidence instead of converting it to success", () => {
  const full = evidence(0)
  full.snapshot = null
  full.runtimeSnapshot = null
  full.afterSnapshotId = null
  full.afterRuntimeSnapshotId = null
  full.checks.typechecked = { status: "unknown", reason: "Validation cancelled", diagnostics: [] }
  full.checks.tested = { status: "not-run", reason: "Compiler did not complete" }
  full.checks.stable = { status: "unknown", reason: "No snapshots completed" }
  full.execution = null
  full.failure = "Validation cancelled"
  const compact = validationOutput(full)
  expect(compact).toMatchObject({ checks: full.checks, snapshot: null, runtimeSnapshot: null, afterSnapshotId: null, afterRuntimeSnapshotId: null, execution: null, failure: full.failure, success: false, evidencePath: null })
})

it("preserves diagnostics, stability failure, paths and output even when they are long", () => {
  const full = evidence(2)
  full.checks.typechecked = { status: "fail", reason: "Type error", diagnostics: [{ code: 2322, category: "Error", message: "Expected number. ".repeat(2000), file: "/workspace/batch.ts", line: 9, column: 4 }] }
  full.checks.stable = { status: "fail", reason: "Inputs changed during execution" }
  full.afterSnapshotId = hash("changed")
  full.evidencePath = "/cache/evidence/result.json"
  full.execution!.stdout = "test output\n".repeat(3000)
  const compact = validationOutput(full)
  expect(compact.checks).toEqual(full.checks)
  expect(compact.execution).toEqual(full.execution)
  expect(compact.afterSnapshotId).toBe(full.afterSnapshotId)
  expect(compact.evidencePath).toBe(full.evidencePath)
})

it("keeps full audit detail opt in without changing the original evidence or recording policy", () => {
  const full = evidence()
  expect(validationOutput(full, "full")).toEqual(full)
  expect(validationOutput(full, "full").snapshot?.inputs).toHaveLength(436)
  expect(validationOutput(full, "full").evidencePath).toBeNull()
  expect(validationSchema.parse({ config: "/workspace/tsconfig.json", detail: "full", record: false })).toEqual({ config: "/workspace/tsconfig.json", detail: "full", record: false })
})


it("replays the recorded failed SQLite validation with unchanged evidence and a small model response", () => {
  const fixtureBytes = readFileSync(new URL("./fixtures/mcp/recorded-sqlite-validation.json", import.meta.url))
  const provenance = JSON.parse(readFileSync(new URL("./fixtures/mcp/recorded-sqlite-validation.provenance.json", import.meta.url), "utf8"))
  expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(provenance.fixtureSha256)
  const source = JSON.parse(readFileSync(new URL(`../${provenance.sourceRun}`, import.meta.url), "utf8"))
  expect(source.actions[provenance.sourceActionIndex]).toMatchObject({ tool: provenance.sourceTool, resultSha256: provenance.sourceResultSha256 })
  const original: ValidationEvidence = JSON.parse(fixtureBytes.toString())
  const before = structuredClone(original)
  const compact = validationOutput(original)
  expect(bytes(original)).toBe(provenance.fixtureSemanticBytes)
  expect(bytes(compact)).toBeLessThan(5_000)
  expect(bytes(compact)).toBeLessThan(bytes(original) / 15)
  expect(compact.checks).toEqual(original.checks)
  expect(compact.execution).toEqual(original.execution)
  expect(compact.snapshot).toMatchObject({ id: original.snapshot!.id, inputCount: 436, inputsOmitted: 436 })
  expect(compact.runtimeSnapshot).toMatchObject({ id: original.runtimeSnapshot!.id, inputCount: 6, inputsOmitted: 6 })
  expect(compact.success).toBe(false)
  expect(compact.evidencePath).toBeNull()
  expect(original).toEqual(before)
  expect(validationOutput(original, "full")).toEqual(original)
})
