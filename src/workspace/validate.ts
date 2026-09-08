import { randomUUID } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { brainHome } from "../paths.js"
import { runCommand } from "./command.js"
import { sha256, type Check, type Overlay } from "./project.js"
import { checkProjectAsync, type RequestControl } from "./runtime.js"
import type { checkProject } from "./check.js"

export type ValidationRequest = {
  config: string
  overlays?: Overlay[] | undefined
  testCommand?: string[] | undefined
  timeoutMs?: number | undefined
  queryId?: string | undefined
  record?: boolean | undefined
  runtimeInputs?: string[] | undefined
  snapshotExclude?: string[] | undefined
  workspaceRoot?: string | undefined
}

export async function validateWorkspace(request: ValidationRequest, control: RequestControl = {}) {
  const started = performance.now()
  const timeout = request.timeoutMs ?? 30_000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000) throw new Error("timeoutMs must be between 1 and 600000")
  const remaining = () => {
    const value = Math.floor(timeout - (performance.now() - started))
    if (value < 1) throw new Error("Validation deadline exceeded")
    if (control.signal?.aborted) throw new Error("Validation cancelled")
    return value
  }
  type ProjectCheck = ReturnType<typeof checkProject>
  let before: ProjectCheck | null = null, after: ProjectCheck | null = null
  let typechecked: Check & { diagnostics: ProjectCheck["typechecked"]["diagnostics"] } = { status: "unknown", reason: "Compiler did not complete", diagnostics: [] }
  let tested: Check = { status: "not-run", reason: "No test command supplied" }
  let stable: Check = { status: "unknown", reason: "Input stability was not established" }
  let execution: Awaited<ReturnType<typeof runCommand>> | null = null
  let failure: string | null = null
  const checkRequest = { ...request, captureRuntime: !!request.testCommand }
  try {
    before = await checkProjectAsync(checkRequest, remaining(), control)
    typechecked = before.typechecked
    if (request.testCommand) {
      if (request.overlays?.length) tested = { status: "not-run", reason: "Tests cannot validate unsaved overlays; save them first" }
      else if (typechecked.status !== "pass") tested = { status: "not-run", reason: "Project type-check failed" }
      else {
        execution = await runCommand(request.testCommand, dirname(resolve(request.config)), remaining(), undefined, control)
        tested = { status: execution.status, reason: "Exit status of the explicitly supplied assertion command" }
      }
    }
    after = await checkProjectAsync(checkRequest, remaining(), control)
    stable = {
      status: before.snapshot.id === after.snapshot.id && before.runtime?.id === after.runtime?.id ? "pass" : "fail",
      reason: "Compared compiler inputs and, when tests were requested, the recorded runtime file scope before and after execution"
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    stable = { status: before ? "fail" : "unknown", reason: failure }
    if (!before) typechecked.reason = failure
  }
  const id = randomUUID()
  const evidence = {
    schemaVersion: 2, id, queryId: request.queryId ?? null, origin: "tool-executed" as const,
    createdAt: new Date().toISOString(), snapshot: before?.snapshot ?? null,
    runtimeSnapshot: before?.runtime ?? null, afterSnapshotId: after?.snapshot.id ?? null,
    afterRuntimeSnapshotId: after?.runtime?.id ?? null,
    environmentHash: sha256(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))),
    checks: { typechecked, tested, stable }, execution, failure,
    success: typechecked.status === "pass" && tested.status === "pass" && stable.status === "pass",
    durationMs: performance.now() - started
  }
  let evidencePath: string | null = null
  if (request.record !== false && process.env.TYPELATCH_USAGE !== "off") {
    const directory = join(brainHome(), "evidence")
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    evidencePath = join(directory, `${id}.json`)
    const temporary = `${evidencePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temporary, evidencePath)
  }
  return { ...evidence, evidencePath }
}
