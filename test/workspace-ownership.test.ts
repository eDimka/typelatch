import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { workspaceContext } from "../src/workspace/context.js"
import { WorkspaceProject, openProjectForFile } from "../src/workspace/project.js"

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "typelatch-ownership-test-"))
  roots.push(root)
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const json = (path: string, value: unknown) => write(path, JSON.stringify(value))
  json("package.json", { name: "ownership-fixture", version: "1.0.0", type: "module" })
  mkdirSync(join(root, "node_modules"))
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  write("shared.ts", 'import { adapt } from "adapter"; export { adapt };')
  const options = { target: "ES2022", module: "NodeNext", strict: true, types: [], skipLibCheck: true }
  for (const [leaf, parameter] of [["a", "string"], ["b", "number"]]) {
    json(`${leaf}/tsconfig.json`, { compilerOptions: { ...options, paths: { adapter: ["./adapter.ts"] } }, files: ["../shared.ts", "./adapter.ts"] })
    write(`${leaf}/adapter.ts`, `export function adapt(value: ${parameter}): ${parameter} { return value; }`)
  }
  json("tsconfig.ab.json", { files: [], references: [{ path: "./a" }, { path: "./b" }] })
  json("tsconfig.ba.json", { files: [], references: [{ path: "./b" }, { path: "./a" }] })
  const request = { file: join(root, "shared.ts"), importSpecifier: "adapter", symbol: "adapt" }
  return { root, write, json, options, request, config: (name: string) => join(root, name) }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("compiler project ownership", () => {
  it("refuses ambiguous delegated ownership independently of reference order", () => {
    const f = fixture()
    const error = `Ambiguous project ownership for ${f.request.file}. Matching configs: ${f.config("a/tsconfig.json")}, ${f.config("b/tsconfig.json")}. Supply an explicit owning config.`
    for (const config of ["tsconfig.ab.json", "tsconfig.ba.json"]) {
      expect(() => workspaceContext({ ...f.request, config: f.config(config) })).toThrow(error)
    }
  })

  it("keeps distinct APIs for explicit leaf selections", () => {
    const f = fixture()
    for (const [leaf, parameter] of [["a", "string"], ["b", "number"]]) {
      const result = workspaceContext({ ...f.request, config: f.config(`${leaf}/tsconfig.json`) })
      expect(result.snapshot.config).toBe(f.config(`${leaf}/tsconfig.json`))
      expect(result.api?.signatures).toEqual([`(value: ${parameter}): ${parameter}`])
      expect(result.checks.typechecked.status).toBe("not-run")
    }
  })

  it("preserves directly included source even when references compete or cannot be parsed", () => {
    const f = fixture()
    f.write("broken/tsconfig.json", "{")
    f.json("tsconfig.direct.json", { compilerOptions: { ...f.options, paths: { adapter: ["./a/adapter.ts"] } }, files: ["./shared.ts"], references: [{ path: "./a" }, { path: "./b" }, { path: "./broken" }] })
    const selected = openProjectForFile(f.config("tsconfig.direct.json"), f.request.file)
    try { expect(selected.config).toBe(f.config("tsconfig.direct.json")) }
    finally { selected.dispose() }
  })

  it("preserves unique ownership, relative request paths and overlay evidence", () => {
    const f = fixture()
    f.json("tsconfig.unique.json", { files: [], references: [{ path: "./a" }] })
    const result = workspaceContext({ ...f.request, file: "shared.ts", config: f.config("tsconfig.unique.json"), overlays: [{ file: "a/adapter.ts", text: "export function adapt(value: boolean): boolean { return value; }" }] })
    expect(result.snapshot.config).toBe(f.config("a/tsconfig.json"))
    expect(result.snapshot.overlayFiles).toEqual([f.config("a/adapter.ts")])
    expect(result.api?.signatures).toEqual(["(value: boolean): boolean"])
    expect(result.originalSourceHash).toBe(workspaceContext({ ...f.request, config: f.config("a/tsconfig.json") }).originalSourceHash)
  })

  it("preserves source imported into a reference free leaf", () => {
    const f = fixture()
    f.write("b/entry.ts", 'import "../shared.js";')
    f.json("b/tsconfig.json", { compilerOptions: { ...f.options, paths: { adapter: ["./adapter.ts"] } }, files: ["./entry.ts", "./adapter.ts"] })
    f.json("tsconfig.unique.json", { files: [], references: [{ path: "./b" }] })
    for (const config of ["b/tsconfig.json", "tsconfig.unique.json"]) {
      const result = workspaceContext({ ...f.request, config: f.config(config) })
      expect(result.snapshot.config).toBe(f.config("b/tsconfig.json"))
      expect(result.api?.signatures).toEqual(["(value: number): number"])
    }
    expect(() => workspaceContext({ ...f.request, config: f.config("tsconfig.ab.json") })).toThrow("Ambiguous project ownership")
  })

  it("examines descendants of a delegated config that includes the target", () => {
    const f = fixture()
    f.json("a/tsconfig.json", { compilerOptions: { ...f.options, paths: { adapter: ["./adapter.ts"] } }, files: ["../shared.ts", "./adapter.ts"], references: [{ path: "../b" }] })
    f.json("tsconfig.nested.json", { files: [], references: [{ path: "./a" }] })
    expect(() => workspaceContext({ ...f.request, config: f.config("tsconfig.nested.json") })).toThrow(`Matching configs: ${f.config("a/tsconfig.json")}, ${f.config("b/tsconfig.json")}`)
    const selected = openProjectForFile(f.config("a/tsconfig.json"), f.request.file)
    try { expect(selected.config).toBe(f.config("a/tsconfig.json")) }
    finally { selected.dispose() }
  })

  it("deduplicates duplicate and diamond references and terminates cycles", () => {
    const f = fixture()
    f.json("tsconfig.unique.json", { files: [], references: [{ path: "./bridge-a" }, { path: "./bridge-b" }, { path: "./bridge-a" }] })
    for (const bridge of ["bridge-a", "bridge-b"]) f.json(`${bridge}/tsconfig.json`, { files: [], references: [{ path: "../a" }] })
    f.json("a/tsconfig.json", { compilerOptions: { ...f.options, paths: { adapter: ["./adapter.ts"] } }, files: ["../shared.ts", "./adapter.ts"], references: [{ path: "../tsconfig.unique.json" }] })
    const disposed = vi.spyOn(WorkspaceProject.prototype, "dispose")
    const selected = openProjectForFile(f.config("tsconfig.unique.json"), f.request.file)
    try { expect(selected.config).toBe(f.config("a/tsconfig.json")) }
    finally { selected.dispose() }
    expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.unique.json", "bridge-a/tsconfig.json", "bridge-b/tsconfig.json", "a/tsconfig.json"].map(f.config).sort())
  })

  it("disposes all constructed services on ambiguity", () => {
    const f = fixture()
    const disposed = vi.spyOn(WorkspaceProject.prototype, "dispose")
    expect(() => openProjectForFile(f.config("tsconfig.ab.json"), f.request.file)).toThrow("Ambiguous project ownership")
    expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.ab.json", "a/tsconfig.json", "b/tsconfig.json"].map(f.config).sort())
  })

  it("disposes unselected services but leaves a unique winner live for its caller", () => {
    const f = fixture()
    f.json("tsconfig.unique.json", { files: [], references: [{ path: "./a" }, { path: "./c" }] })
    f.write("c/entry.ts", "export const unrelated = true;")
    f.json("c/tsconfig.json", { compilerOptions: f.options, files: ["./entry.ts"] })
    const disposed = vi.spyOn(WorkspaceProject.prototype, "dispose")
    const selected = openProjectForFile(f.config("tsconfig.unique.json"), f.request.file)
    try {
      expect(selected.config).toBe(f.config("a/tsconfig.json"))
      expect(selected.source(f.request.file).fileName).toBe(f.request.file)
      expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.unique.json", "c/tsconfig.json"].map(f.config).sort())
    } finally { selected.dispose() }
    expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.unique.json", "a/tsconfig.json", "c/tsconfig.json"].map(f.config).sort())
  })

  it("disposes services when no reachable project includes the target", () => {
    const f = fixture()
    f.write("c/entry.ts", "export const unrelated = true;")
    f.json("c/tsconfig.json", { compilerOptions: f.options, files: ["./entry.ts"] })
    f.json("tsconfig.missing.json", { files: [], references: [{ path: "./c" }] })
    const disposed = vi.spyOn(WorkspaceProject.prototype, "dispose")
    expect(() => openProjectForFile(f.config("tsconfig.missing.json"), f.request.file)).toThrow(`File is not included in this project: ${f.request.file}`)
    expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.missing.json", "c/tsconfig.json"].map(f.config).sort())
  })

  it("does not hide a malformed config behind one or several owners", () => {
    const f = fixture()
    f.write("z/tsconfig.json", "{")
    const disposed = vi.spyOn(WorkspaceProject.prototype, "dispose")
    for (const references of [["./a", "./z"], ["./a", "./b", "./z"], ["./z", "./b", "./a"]]) {
      disposed.mockClear()
      f.json("tsconfig.invalid.json", { files: [], references: references.map(path => ({ path })) })
      expect(() => openProjectForFile(f.config("tsconfig.invalid.json"), f.request.file)).toThrow(`Could not inspect referenced config ${f.config("z/tsconfig.json")}`)
      expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.invalid.json", "a/tsconfig.json", ...(references.includes("./b") ? ["b/tsconfig.json"] : [])].map(f.config).sort())
    }
  })

  it("disposes constructed services when a membership probe throws", () => {
    const f = fixture()
    f.write("c/entry.ts", "export const unrelated = true;")
    f.json("c/tsconfig.json", { compilerOptions: f.options, files: ["./entry.ts"] })
    f.json("tsconfig.probe.json", { files: [], references: [{ path: "./a" }, { path: "./c" }] })
    const disposed = vi.spyOn(WorkspaceProject.prototype, "dispose")
    vi.spyOn(WorkspaceProject.prototype, "program").mockImplementation(() => { throw new Error("Membership probe failed") })
    expect(() => openProjectForFile(f.config("tsconfig.probe.json"), f.request.file)).toThrow("Membership probe failed")
    expect(disposed.mock.instances.map(project => project.config).sort()).toEqual(["tsconfig.probe.json", "a/tsconfig.json", "c/tsconfig.json"].map(f.config).sort())
  })
})
