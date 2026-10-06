import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

type Slot = {
  child: ChildProcessWithoutNullStreams
  key: string
  busy: boolean
  idle?: NodeJS.Timeout | undefined
}
const slots: Slot[] = []

/** Make room for a one-shot check within the same global process budget. */
export function retireIdleWorkers(): void {
  for (const slot of slots.filter(s => !s.busy)) stop(slot)
}

function stop(slot: Slot): void {
  clearTimeout(slot.idle)
  const index = slots.indexOf(slot)
  if (index >= 0) slots.splice(index, 1)
  try {
    if (slot.child.pid && process.platform !== "win32") process.kill(-slot.child.pid, "SIGKILL")
    else slot.child.kill("SIGKILL")
  } catch { /* Already exited. */ }
  slot.child.stdin.destroy()
  slot.child.stdout.destroy()
  slot.child.stderr.destroy()
}

function referenced(slot: Slot, ref: boolean): void {
  if (ref) slot.child.ref(); else slot.child.unref()
  for (const stream of [slot.child.stdin, slot.child.stdout, slot.child.stderr]) {
    const handle = stream as typeof stream & { ref?: () => void; unref?: () => void }
    if (ref) handle.ref?.(); else handle.unref?.()
  }
}

/** The caller owns the global two-active/sixteen-queued admission limit. */
export async function persistentRequest<T>(command: string[], input: string, deadline: number, signal?: AbortSignal, operation: "context" | "search" = "context"): Promise<T> {
  const label = operation === "search" ? "Search" : "Compiler"
  const inputLimit = operation === "search" ? 1_000_000 : 55_000_000
  if (Buffer.byteLength(input) > inputLimit) throw new Error(operation === "search" ? "Search request exceeds 1 MB" : "Request exceeds 55 MB")
  const key = JSON.stringify([command, process.cwd(), process.env])
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new Error("Request cancelled")
    const remaining = Math.floor(deadline - performance.now())
    if (remaining < 1) throw new Error(`${label} worker timed out`)
    let slot = slots.find(s => !s.busy && s.key === key)
    if (!slot) {
      for (const unused of slots.filter(s => !s.busy)) stop(unused)
      if (slots.length >= 2) throw new Error(`${label} worker capacity exceeded`)
      const child = spawn(command[0]!, [...command.slice(1), "--persistent"], {
        cwd: process.cwd(), shell: false, detached: process.platform !== "win32", stdio: "pipe"
      })
      slot = { child, key, busy: false }
      slots.push(slot)
      child.stdin.on("error", () => { /* close/error reports the failure */ })
      const current = slot
      child.on("exit", () => { if (!current.busy) stop(current) })
      // Prevent an idle child's unexpected error from becoming uncaught.
      child.on("error", () => { if (!current.busy) stop(current) })
    }
    const current = slot
    clearTimeout(current.idle)
    current.busy = true
    referenced(current, true)
    const envelope = await new Promise<{ ok: boolean; result: T; error?: string; restart?: boolean }>((resolve, reject) => {
      let stdout = "", stderr = "", bytes = 0, settled = false
      const child = current.child
      const clean = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        child.stdout.off("data", output)
        child.stderr.off("data", errors)
        child.off("error", failed)
        child.off("close", closed)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clean()
        stop(current)
        reject(error)
      }
      const abort = () => fail(new Error("Request cancelled"))
      const failed = (error: Error) => fail(error)
      const closed = (code: number | null, reason: string | null) => fail(new Error(`${label} worker failed: ${stderr.slice(-2000) || reason || code}`))
      const collect = (data: string): boolean => {
        bytes += Buffer.byteLength(data)
        if (bytes > 8_000_000) { fail(new Error(`${label} response exceeded 8 MB; narrow the project or request`)); return false }
        return true
      }
      const errors = (data: string) => { if (collect(data)) stderr += data }
      const output = (data: string) => {
        if (!collect(data)) return
        stdout += data
        const newline = stdout.indexOf("\n")
        if (newline < 0) return
        try {
          if (newline !== stdout.length - 1) throw new Error("Unexpected trailing worker output")
          const value = JSON.parse(stdout)
          if (typeof value.ok !== "boolean") throw new Error("Invalid envelope")
          settled = true
          clean()
          current.busy = false
          referenced(current, false)
          current.idle = setTimeout(() => stop(current), 30_000)
          current.idle.unref()
          resolve(value)
        } catch { fail(new Error(`${label} produced an invalid response`)) }
      }
      const timer = setTimeout(() => fail(new Error(`${label} worker timed out`)), remaining)
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", output)
      child.stderr.on("data", errors)
      child.on("error", failed)
      child.on("close", closed)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      else child.stdin.write(input + "\n")
    })
    if (envelope.restart) { stop(current); continue }
    if (!envelope.ok) { stop(current); throw new Error(envelope.error ?? `${label} request failed`) }
    return envelope.result
  }
  throw new Error(`${label} inputs changed repeatedly during request`)
}

export { persistentRequest as persistentContext, retireIdleWorkers as retireIdleContextWorkers }
