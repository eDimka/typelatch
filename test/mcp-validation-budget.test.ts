import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, expect, it } from "vitest"

let root: string
let client: Client
let compact: Awaited<ReturnType<Client["callTool"]>>
const request = () => ({
  config: join(root, "tsconfig.json"), record: false,
  testCommand: [process.execPath, "-e", 'process.stdout.write("intentional assertion failure\\n"); process.exit(1)'],
})
const data = (response: Awaited<ReturnType<Client["callTool"]>>) => {
  expect(response.isError).not.toBe(true)
  expect(response.structuredContent).toBeDefined()
  const text = response.content.find(item => item.type === "text")
  expect(text?.type).toBe("text")
  const parsed = JSON.parse(text && text.type === "text" ? text.text : "null")
  expect(parsed).toEqual(response.structuredContent)
  return parsed
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-mcp-budget-")))
  mkdirSync(join(root, "node_modules"))
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "wire-budget-fixture", private: true }))
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", types: [] }, include: ["src/*.ts"] }))
  for (let index = 0; index < 300; index++) writeFileSync(join(root, `src/value-${index}.ts`), `export const value${index} = ${index}\n`)
  client = new Client({ name: "typelatch-response-budget-test", version: "1.0.0" })
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ["--import", "tsx", resolve("src/mcp.ts")],
    env: { ...process.env, TYPELATCH_HOME: join(root, "data"), TYPELATCH_USAGE: "on" }, stderr: "pipe",
  }))
  compact = await client.callTool({ name: "workspace_validate", arguments: request() })
}, 30000)

afterAll(async () => {
  await client?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

it("keeps default validation JSON below 16 KiB across the actual MCP stdio connection", () => {
  const value = data(compact)
  expect(value.checks.typechecked.status).toBe("pass")
  expect(value.checks.tested.status).toBe("fail")
  expect(value.checks.stable.status).toBe("pass")
  expect(value.success).toBe(false)
  expect(value.execution.exitCode).toBe(1)
  expect(value.execution.stdout).toBe("intentional assertion failure\n")
  expect(value.evidencePath).toBeNull()
  expect(existsSync(join(root, "data/evidence"))).toBe(false)
  expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(16 * 1024)
})

it("preserves exact manifest evidence only on an explicit full request", async () => {
  const response = await client.callTool({ name: "workspace_validate", arguments: { ...request(), detail: "full" } })
  const full = data(response), small = data(compact)
  expect(full.snapshot.inputs.length).toBeGreaterThanOrEqual(300)
  expect(full.runtimeSnapshot.inputs.length).toBeGreaterThanOrEqual(300)
  for (const field of ["snapshot", "runtimeSnapshot"] as const) {
    expect(small[field].id).toBe(full[field].id)
    expect(Object.hasOwn(small[field], "inputs")).toBe(false)
    expect(small[field].inputCount).toBe(full[field].inputs.length)
    expect(small[field].inputsOmitted).toBe(full[field].inputs.length)
  }
  expect(small.checks).toEqual(full.checks)
  expect(small.evidencePath).toBeNull()
  expect(full.evidencePath).toBeNull()
  expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(16 * 1024)
}, 30000)

it("keeps usage opt-out effective even when the MCP caller requests recording", async () => {
  const privateHome = join(root, "private-data")
  const privateClient = new Client({ name: "typelatch-recording-opt-out-test", version: "1.0.0" })
  try {
    await privateClient.connect(new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", resolve("src/mcp.ts")],
      env: { ...process.env, TYPELATCH_HOME: privateHome, TYPELATCH_USAGE: "off" }, stderr: "pipe",
    }))
    const response = await privateClient.callTool({ name: "workspace_validate", arguments: { ...request(), record: true } })
    expect(data(response).evidencePath).toBeNull()
    expect(existsSync(join(privateHome, "evidence"))).toBe(false)
  } finally { await privateClient.close() }
}, 30000)

it("records the complete audit manifest while returning a compact MCP view", async () => {
  const response = await client.callTool({ name: "workspace_validate", arguments: { ...request(), record: true } })
  const small = data(response)
  expect(typeof small.evidencePath).toBe("string")
  const stored = JSON.parse(readFileSync(small.evidencePath, "utf8"))
  for (const field of ["snapshot", "runtimeSnapshot"] as const) {
    expect(Object.hasOwn(small[field], "inputs")).toBe(false)
    expect(stored[field].inputs.length).toBeGreaterThanOrEqual(300)
    expect(small[field].inputCount).toBe(stored[field].inputs.length)
    expect(small[field].id).toBe(stored[field].id)
  }
  expect(small.checks).toEqual(stored.checks)
  expect(small.execution).toEqual(stored.execution)
  expect(small.success).toBe(stored.success)
}, 30000)
