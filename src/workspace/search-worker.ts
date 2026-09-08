import { workspaceSearch } from "./search.js"

let input = ""
try {
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 1_000_000) throw new Error("Search request exceeds 1 MB")
  }
  const envelope = JSON.parse(input)
  if (envelope.operation !== "search") throw new Error("Unknown search worker operation")
  const result = await workspaceSearch(envelope.request)
  process.stdout.write(JSON.stringify({ ok: true, result }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
}
