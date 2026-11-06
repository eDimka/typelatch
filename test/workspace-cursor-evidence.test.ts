import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { workspaceContext } from "../src/workspace/context.js"
import { workspaceContextAsync } from "../src/workspace/runtime.js"
import { retireIdleContextWorkers } from "../src/workspace/persistent.js"

const roots: string[] = []
function fixture(text: string) {
  const root = mkdtempSync(join(tmpdir(), "typelatch-cursor-evidence-"))
  roots.push(root)
  const config = join(root, "tsconfig.json")
  const file = join(root, "main.ts")
  writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, types: [], skipLibCheck: true }, files: ["main.ts"] }))
  writeFileSync(file, text)
  mkdirSync(join(root, "node_modules"))
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  return { config, file }
}
afterEach(() => {
  retireIdleContextWorkers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("reports references omitted from the selected compiler project", () => {
  const text = "export function work(value: number) { return value; }\n" + Array.from({ length: 55 }, (_, index) => `work(${index});\n`).join("")
  const request = { ...fixture(text), position: text.indexOf("work") }
  const result = workspaceContext(request)
  expect(result.references).toHaveLength(50)
  expect(result).toMatchObject({ cursorEvidence: {
    scope: "compiler-project", config: request.config, position: request.position,
    definitions: { status: "complete", total: 1, returned: 1, omitted: 0, limit: 20 },
    references: { status: "truncated", total: 56, returned: 50, omitted: 6, limit: 50 }
  } })
})

it("reports all compiler references when the result reaches the return limit", () => {
  const text = "export function work(value: number) { return value; }\n" + Array.from({ length: 49 }, (_, index) => `work(${index});\n`).join("")
  const result = workspaceContext({ ...fixture(text), position: text.indexOf("work") })
  expect(result.references).toHaveLength(50)
  expect(result.cursorEvidence.references).toEqual({ status: "complete", total: 50, returned: 50, omitted: 0, limit: 50 })
})

it("reports omitted merged declarations without dropping their compiler count", () => {
  const text = Array.from({ length: 21 }, (_, index) => `export interface Merge { p${index}: number }\n`).join("") + "export let value: Merge;\n"
  const result = workspaceContext({ ...fixture(text), position: text.lastIndexOf("Merge") })
  expect(result.definitions).toHaveLength(20)
  expect(result.cursorEvidence.definitions).toEqual({ status: "truncated", total: 21, returned: 20, omitted: 1, limit: 20 })
})

it("distinguishes a missing cursor from an empty compiler result", () => {
  const request = fixture("export const value = 42;\n\n")
  const unqueried = workspaceContext(request)
  const empty = workspaceContext({ ...request, position: 24 })
  expect(unqueried.cursorEvidence).toMatchObject({ position: null,
    definitions: { status: "not-run", total: null, returned: 0, omitted: null },
    references: { status: "not-run", total: null, returned: 0, omitted: null }
  })
  expect(empty.cursorEvidence).toMatchObject({ position: 24,
    definitions: { status: "complete", total: 0, returned: 0, omitted: 0 },
    references: { status: "complete", total: 0, returned: 0, omitted: 0 }
  })
  expect(empty.checks.resolved.status).toBe("unknown")
  expect(empty.checks.typechecked.status).toBe("not-run")
})

it("preserves cursor counts and locations across compiler worker transport", async () => {
  const text = "export function work(value: number) { return value; }\n" + Array.from({ length: 55 }, (_, index) => `work(${index});\n`).join("")
  const request = { ...fixture(text), position: text.indexOf("work") }
  const direct = workspaceContext(request)
  const worker = await workspaceContextAsync(request)
  expect(worker.cursorEvidence).toEqual(direct.cursorEvidence)
  expect(worker.cursorEvidence.references).toEqual({ status: "truncated", total: 56, returned: 50, omitted: 6, limit: 50 })
  expect(worker.references).toEqual(direct.references)
  expect(worker.definitions).toEqual(direct.definitions)
})
