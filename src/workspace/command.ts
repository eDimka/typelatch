import { spawn } from "node:child_process"

/** Explicit argv only, bounded time/output, no shell interpolation. */
export async function runCommand(command: string[], cwd: string, timeoutMs = 30_000, input?: string, options: { signal?: AbortSignal | undefined; maxOutputBytes?: number } = {}) {
  if (!command[0] || command.some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("Expected a non-empty command argv array")
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be between 1 and 600000")
  const started = performance.now()
  return await new Promise<{
    command: string[]; cwd: string; exitCode: number | null; signal: string | null;
    status: "pass" | "fail"; timedOut: boolean; outputLimitExceeded: boolean; cancelled: boolean;
    stdout: string; stderr: string; durationMs: number
  }>(resolve => {
    const child = spawn(command[0]!, command.slice(1), { cwd, shell: false, detached: process.platform !== "win32", stdio: "pipe" })
    let stdout = "", stderr = "", bytes = 0, timedOut = false, cancelled = false, outputLimitExceeded = false, settled = false
    const stop = () => {
      if (!child.pid) return
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { /* Already exited. */ }
    }
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      resolve({ command, cwd, exitCode, signal, status: exitCode === 0 && !timedOut && !cancelled && !outputLimitExceeded ? "pass" : "fail", timedOut, cancelled, outputLimitExceeded, stdout, stderr, durationMs: performance.now() - started })
    }
    const abort = () => { cancelled = true; stop() }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const collect = (data: string, stream: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(data)
      if (bytes > (options.maxOutputBytes ?? 1_000_000)) { outputLimitExceeded = true; stop(); return }
      if (stream === "stdout") stdout += data
      else stderr += data
    }
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", data => collect(data, "stdout"))
    child.stderr.on("data", data => collect(data, "stderr"))
    child.on("error", error => { stderr += error.message; finish(null, null) })
    child.on("close", finish)
    child.stdin.on("error", () => { /* Early process exit is reported by close. */ })
    child.stdin.end(input)
  })
}
