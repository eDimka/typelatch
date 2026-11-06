import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { workspaceSearch } from "../src/workspace/search.js"
import { sourceContext } from "../src/workspace/source-context.js"

let directory: string
let root: string
let previousHome: string | undefined
const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-source-context-")))
  root = join(directory, "repo")
  mkdirSync(root)
  execFileSync("git", ["init", "-q", root])
  previousHome = process.env.TYPELATCH_HOME
  process.env.TYPELATCH_HOME = join(directory, "data")
  put("package.json", '{"name":"fixture","type":"module"}')
  put("src/helper.ts", 'export const convertInput = (text: string) => text.trim()\n')
  put("src/main.ts", `import { convertInput } from "./helper.js"\nexport function normalizePayload(text: string) {\n${"  // Preserve request behavior.\n".repeat(16)}  return convertInput(text)\n}\n`)
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})

it("returns complete selected source and direct relative imports without changing retrieval or evidence", async () => {
  const input = { workspaceRoot: root, question: "normalizePayload", scope: "workspace" as const }
  const full = await workspaceSearch(input)
  const source = await workspaceSearch({ ...input, detail: "source" })
  expect(source.results.map(item => [item.source, item.line, item.symbol])).toEqual(full.results.map(item => [item.source, item.line, item.symbol]))
  expect(source.coverage).toEqual(full.coverage)
  expect(source.checks).toEqual(full.checks)
  expect(source.sourceContext.files.map(file => file.source)).toEqual([join(root, "src/main.ts"), join(root, "src/helper.ts")])
  for (const file of source.sourceContext.files) {
    expect(file.text).toBe(readFileSync(file.source, "utf8"))
    expect(file.complete).toBe(true)
    expect(file.omittedBytes).toBe(0)
    expect(file.sha256).toBe(createHash("sha256").update(file.text).digest("hex"))
  }
  expect(source.sourceContext.files[1].reason).toBe("relative-import")
  expect(source.sourceContext.resolution).toBe("not-run")
})

it("does not follow comment strings, ignored files, parent paths or a second import hop", async () => {
  put(".gitignore", "src/private.ts\n")
  put("src/private.ts", 'export const privateValue = "hidden"\n')
  put("src/decoy.ts", 'export const decoy = true\n')
  put("src/grandchild.ts", 'export const third = true\n')
  symlinkSync(join(root, "src/decoy.ts"), join(root, "src/linked.ts"))
  put("src/helper.ts", 'export { third } from "./grandchild.js"\nexport const helper = true\n')
  put("src/main.ts", 'import "./helper.js"\nimport "./private.js"\nimport "./linked.js"\nimport "../../outside.js"\n// import "./decoy.js"\nconst note = `import "./decoy.js"`\nexport const normalizePayload = note\n')
  const result = await workspaceSearch({ workspaceRoot: root, question: "normalizePayload", scope: "workspace", detail: "source", limit: 1 })
  expect(result.sourceContext.files.map(file => file.source)).toEqual([join(root, "src/main.ts"), join(root, "src/helper.ts")])
  expect(result.sourceContext.unavailableImports).toBe(3)
})

it("bounds UTF8 source bytes, discloses omitted content and refreshes same length edits", async () => {
  put("src/main.ts", `export const normalizePayload = ${JSON.stringify("🦊".repeat(9000))}\n`)
  const input = { workspaceRoot: root, question: "normalizePayload", scope: "workspace" as const, detail: "source" as const }
  const before = await workspaceSearch(input)
  const context = before.sourceContext
  expect(context.bytes).toBeLessThanOrEqual(context.byteLimit)
  expect(context.files[0].omittedBytes).toBeGreaterThan(0)
  expect(context.files[0].complete).toBe(false)
  expect(context.files[0].text).not.toContain("\uFFFD")
  expect(Buffer.byteLength(context.files[0].text)).toBe(context.files[0].bytes)
  put("src/main.ts", `export const normalizePayload = ${JSON.stringify("🐙".repeat(9000))}\n`)
  const after = await workspaceSearch(input)
  expect(after.sourceContext.files[0].sha256).not.toBe(context.files[0].sha256)
  expect(after.sourceContext.files[0].text).toContain("🐙")
  expect(after.sourceContext.files[0].text).not.toContain("🦊")
})

it("includes the matching region of large files and accounts for both omitted ends", async () => {
  put("src/main.ts", `${"// padding\n".repeat(2000)}export const normalizePayload = true\n${"// tail\n".repeat(2000)}`)
  const response = await workspaceSearch({ workspaceRoot: root, question: "normalizePayload", scope: "workspace", detail: "source", limit: 1 })
  const file = response.sourceContext.files[0]
  expect(file.text).toContain("export const normalizePayload = true")
  expect(file.startLine).toBeGreaterThan(1)
  expect(file.omittedBefore).toBeGreaterThan(0)
  expect(file.omittedAfter).toBeGreaterThan(0)
  expect(file.omittedBytes).toBe(file.omittedBefore + file.omittedAfter)
  const original = readFileSync(file.source)
  expect(original.subarray(file.omittedBefore, original.length - file.omittedAfter).toString("utf8")).toBe(file.text)
})

it("keeps the selected hit inside its byte window even after a very long preceding line", () => {
  const text = `// first\n// ${"prefix".repeat(2000)}\n${"// short\n".repeat(7)}export const needle = 42\n`
  const path = join(root, "src/long.ts")
  const context = sourceContext([{ path, text, hash: createHash("sha256").update(text).digest("hex"), searchable: true }],
    [{ source: path, origin: "workspace", line: 10 }], new AbortController().signal)
  expect(context.files[0].text).toContain("export const needle = 42")
  expect(context.files[0].bytes).toBeLessThanOrEqual(context.fileByteLimit)
})

it("bounds aggregate context, counts omitted files and leaves ambiguous imports unresolved", async () => {
  put("src/helper.js", "export const duplicate = true\n")
  const imports = Array.from({ length: 15 }, (_, i) => `import "./extra${i}.js"`).join("\n")
  put("src/main.ts", `import "./helper.js"\n${imports}\nexport const normalizePayload = true\n`)
  for (let i = 0; i < 15; i++) put(`src/extra${i}.ts`, `export const text = ${JSON.stringify("many bytes ".repeat(1500))}\n`)
  const response = await workspaceSearch({ workspaceRoot: root, question: "normalizePayload", scope: "workspace", detail: "source", limit: 1 })
  const context = response.sourceContext
  expect(context.files.some(file => file.source.endsWith("helper.ts") || file.source.endsWith("helper.js"))).toBe(false)
  expect(context.ambiguousImports).toBe(1)
  expect(context.unavailableImports).toBe(1)
  expect(context.filesOmitted).toBe(16 - context.files.length)
  expect(context.files.length).toBeLessThanOrEqual(context.fileLimit)
  expect(context.bytes).toBe(context.files.reduce((sum, file) => sum + file.bytes, 0))
  expect(context.bytes).toBeLessThanOrEqual(context.byteLimit)
  expect(context.files.every(file => file.bytes <= context.fileByteLimit)).toBe(true)
})

it("accepts --source before the CLI question, prints source text, and rejects conflicting detail flags", () => {
  const args = [join(process.cwd(), "dist/cli.js"), "search", "--source", "normalizePayload", "--root", root, "--scope", "workspace"]
  const result = JSON.parse(execFileSync(process.execPath, [...args, "--json"], { encoding: "utf8" }))
  expect(result).toMatchObject({ detail: "source", question: "normalizePayload", status: "ok" })
  expect(result.sourceContext.files).toHaveLength(2)
  expect(execFileSync(process.execPath, args, { encoding: "utf8" })).toContain("return convertInput(text)")
  expect(() => execFileSync(process.execPath, [...args, "--compact"], { stdio: "pipe" })).toThrow()
})
