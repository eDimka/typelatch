import { ContextSession, workspaceContext } from "./context.js"
import { checkProject } from "./check.js"
const persistent = process.argv.includes("--persistent")
const session = persistent ? new ContextSession() : undefined
function execute(input: string) {
  try {
    const envelope = JSON.parse(input)
    const result = envelope.operation === "context" ? workspaceContext(envelope.request, session)
      : envelope.operation === "check" ? checkProject(envelope.request) : (() => { throw new Error("Unknown worker operation") })()
    return JSON.stringify({ ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ ok: false, error: message, restart: message === "APIROVA_RESTART_COMPILER" })
  }
}
let input = ""
try {
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 55_000_000) throw new Error("Request exceeds 55 MB")
    if (persistent) {
      let newline: number
      while ((newline = input.indexOf("\n")) >= 0) {
        const request = input.slice(0, newline)
        input = input.slice(newline + 1)
        process.stdout.write(execute(request) + "\n")
      }
    }
  }
  if (!persistent) process.stdout.write(execute(input))
} finally { session?.dispose() }
