import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runCommand } from "./command.js"
import { persistentContext, retireIdleContextWorkers } from "./persistent.js"
import type { ContextRequest, workspaceContext } from "./context.js"
import type { checkProject } from "./check.js"
import type { SearchRequest, workspaceSearch } from "./search.js"
import { searchSchema } from "./schema.js"

export type RequestControl = { signal?: AbortSignal | undefined }
let active = 0
const queue: Array<() => void> = []

async function acquire(deadline: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Request cancelled")
  if (active < 2) { active++; return }
  if (queue.length >= 16) throw new Error("Worker queue is full; retry when an active request finishes")
  await new Promise<void>((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
    const remove = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1) }
    const abort = () => { remove(); clean(); reject(new Error("Request cancelled")) }
    const start = () => { clean(); active++; resolve() }
    const timer = setTimeout(() => { remove(); clean(); reject(new Error("Request timed out in worker queue")) }, Math.max(1, deadline - performance.now()))
    signal?.addEventListener("abort", abort, { once: true })
    queue.push(start)
  })
}

export async function workerRequest<T>(operation: "context" | "check" | "search", request: unknown, timeoutMs = 30_000, control: RequestControl = {}): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be between 1 and 600000")
  const deadline = performance.now() + timeoutMs
  await acquire(deadline, control.signal)
  try {
    if (control.signal?.aborted) throw new Error("Request cancelled")
    const worker = operation === "search" ? "search-worker" : "worker"
    const label = operation === "search" ? "Search" : "Compiler"
    const built = fileURLToPath(new URL(`./${worker}.js`, import.meta.url))
    const source = fileURLToPath(new URL(`./${worker}.ts`, import.meta.url))
    const command = existsSync(built)
      ? [process.execPath, "--max-old-space-size=1024", built]
      : [process.execPath, "--max-old-space-size=1024", "--import", import.meta.resolve("tsx"), source]
    const remaining = Math.floor(deadline - performance.now())
    if (remaining < 1) throw new Error("Request timed out before worker execution")
    if (operation === "context") return await persistentContext<T>(command, JSON.stringify({ operation, request }), deadline, control.signal)
    if (operation === "check") retireIdleContextWorkers()
    const execution = await runCommand(command, process.cwd(), remaining, JSON.stringify({ operation, request }), { signal: control.signal, maxOutputBytes: 8_000_000 })
    if (execution.cancelled) throw new Error("Request cancelled")
    if (execution.timedOut) throw new Error(`${label} worker timed out`)
    if (execution.outputLimitExceeded) throw new Error(`${label} response exceeded 8 MB; narrow the project or request`)
    if (execution.status !== "pass") throw new Error(`${label} worker failed: ${execution.stderr.slice(-2000) || execution.signal || execution.exitCode}`)
    let envelope: { ok: boolean; result: T; error?: string }
    try { envelope = JSON.parse(execution.stdout) } catch { throw new Error(`${label} produced an invalid response`) }
    if (!envelope.ok) throw new Error(envelope.error ?? `${label} request failed`)
    return envelope.result
  } finally {
    active--
    queue.shift()?.()
  }
}

export async function workspaceContextAsync(request: ContextRequest, control: RequestControl = {}) {
  return workerRequest<ReturnType<typeof workspaceContext>>("context", request, request.timeoutMs, control)
}
export async function checkProjectAsync(request: Parameters<typeof checkProject>[0], timeoutMs: number, control: RequestControl = {}) {
  return workerRequest<ReturnType<typeof checkProject>>("check", request, timeoutMs, control)
}
export async function workspaceSearchAsync(request: SearchRequest, control: RequestControl = {}) {
  const parsed = searchSchema.parse(request)
  const started = performance.now()
  const response = await workerRequest<Awaited<ReturnType<typeof workspaceSearch>>>("search", parsed, parsed.timeoutMs ?? 60_000, control)
  return { ...response, searchMs: response.latencyMs, latencyMs: Math.round(performance.now() - started) }
}
