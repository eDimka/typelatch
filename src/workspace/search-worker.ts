import { workspaceSearch } from "./search.js"

const persistent = process.argv.includes("--persistent")
async function execute(input: string) {
  try {
    const envelope = JSON.parse(input)
    if (envelope.operation !== "search") throw new Error("Unknown search worker operation")
    return JSON.stringify({ ok: true, result: await workspaceSearch(envelope.request) })
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

let input = ""
try {
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    input += chunk
    if (persistent) {
      let newline: number
      while ((newline = input.indexOf("\n")) >= 0) {
        const request = input.slice(0, newline)
        input = input.slice(newline + 1)
        if (Buffer.byteLength(request) > 1_000_000) throw new Error("Search request exceeds 1 MB")
        process.stdout.write(await execute(request) + "\n")
      }
    }
    if (Buffer.byteLength(input) > 1_000_000) throw new Error("Search request exceeds 1 MB")
  }
  if (!persistent) process.stdout.write(await execute(input))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + (persistent ? "\n" : ""))
}
