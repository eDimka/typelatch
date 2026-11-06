import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { workspaceSearch } from "../src/workspace/search.js"

let directory: string
let root: string
let previousHome: string | undefined
const targetText = "export function priorityNeedle() { return 1 }\n"
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}
const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
  env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C", LC_ALL: "C", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  timeout: 10_000
})
const search = (file?: string, scope: "workspace" | "all" | "dependencies" = "workspace") => workspaceSearch({ workspaceRoot: root, question: "priorityNeedle", scope, detail: "compact", limit: 5, ...(file ? { file } : {}) })
const entryPrefix = () => {
  for (let index = 0; index < 20_000; index++) put(`a/${String(index).padStart(5, "0")}.txt`, index === 0 ? "priorityNeedle\n" : "")
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-file-hint-test-")))
  root = join(directory, "repo")
  mkdirSync(root)
  previousHome = process.env.TYPELATCH_HOME
  process.env.TYPELATCH_HOME = join(directory, "data")
  git("init", "-q")
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})

it("admits an eligible file hint before the entry cutoff while retaining other matching files", async () => {
  entryPrefix()
  put("z/target.ts", targetText)
  const result = await search("z/target.ts")
  expect(result.results.map(item => item.source)).toContain(join(root, "z/target.ts"))
  expect(result.results.map(item => item.source)).toContain(join(root, "a/00000.txt"))
  expect(result.status).toBe("partial")
  expect(result.coverage.complete).toBe(false)
  expect(result.coverage.issues).toContain("File inventory limited to 20000 entries")
  expect(result.coverage.files).toBe(20_000)
  expect(result.coverage).toMatchObject({ fileHint: { path: "z/target.ts", admission: "admitted", priorityApplied: true, sourceHash: createHash("sha256").update(targetText).digest("hex") } })
}, 60_000)

it("admits an eligible file hint before the byte cutoff without making coverage complete", async () => {
  for (let index = 0; index < 68; index++) put(`a/${String(index).padStart(2, "0")}.txt`, index === 0 ? "priorityNeedle\n" + "x".repeat(999_985) : "x".repeat(1_000_000))
  put("z/target.ts", targetText)
  const result = await search("z/target.ts")
  expect(result.results.map(item => item.source)).toContain(join(root, "z/target.ts"))
  expect(result.results.map(item => item.source)).toContain(join(root, "a/00.txt"))
  expect(result.coverage.files).toBe(68)
  expect(result.status).toBe("partial")
  expect(result.coverage.issues).toContain("Workspace text inventory exceeds 64 MiB")
  expect(result.coverage).toMatchObject({ fileHint: { admission: "admitted", priorityApplied: true } })
}, 60_000)

it("does not evict eligible entries for a tracked oversized last-entry hint", async () => {
  entryPrefix()
  put("z/rejected.ts", "x".repeat(1_000_001))
  git("add", "--all", "--", ".")
  const before = await search()
  const hinted = await search("z/rejected.ts")
  expect(hinted.coverage.files).toBe(20_000)
  expect(hinted.index?.snapshot).toBe(before.index?.snapshot)
  expect(hinted.index).toMatchObject({ updatedFiles: 0, removedFiles: 0 })
  expect(hinted.results).toEqual(before.results)
  expect(hinted.coverage).toMatchObject({ fileHint: { admission: "not-admitted", priorityApplied: false, sourceHash: null, reason: "file exceeds 1 MB" } })
}, 60_000)

it("preserves canonical project, config and dependency coverage for an unchanged package hint set", async () => {
  put("package.json", JSON.stringify({ name: "root", private: true }))
  for (const [path, name] of [["a", "parent"], ["a/b", "nested"]]) {
    put(`${path}/package.json`, JSON.stringify({ name, version: "1.0.0", dependencies: { common: "1.0.0" } }))
    put(`${path}/tsconfig.json`, "{}")
  }
  put("node_modules/common/package.json", JSON.stringify({ name: "common", version: "1.0.0" }))
  put("a/b/index.ts", targetText)
  const before = await search(undefined, "all")
  expect(before.coverage.projects).toEqual([join(root, "a/b"), join(root, "a"), root])
  expect(before.coverage.configs).toEqual([join(root, "a/b/tsconfig.json"), join(root, "a/tsconfig.json")])
  const hinted = await search("a/package.json", "all")
  expect(hinted.index?.snapshot).toBe(before.index?.snapshot)
  expect(hinted.index).toMatchObject({ updatedFiles: 0, removedFiles: 0 })
  expect(hinted.coverage.projects).toEqual(before.coverage.projects)
  expect(hinted.coverage.configs).toEqual(before.coverage.configs)
  expect(hinted.coverage.dependencies).toEqual(before.coverage.dependencies)
  expect(hinted.coverage.issues).toEqual(before.coverage.issues)
  expect(hinted.coverage).toMatchObject(before.coverage)
})

it("keeps the normal byte charge when a promoted hinted file is binary", async () => {
  for (let index = 0; index < 67; index++) put(`a/${String(index).padStart(2, "0")}.txt`, index === 0 ? "priorityNeedle\n" + "x".repeat(999_985) : "x".repeat(1_000_000))
  put("z/binary.txt", "\0" + "x".repeat(999_999))
  const result = await search("z/binary.txt")
  expect(result.coverage.files).toBe(66)
  expect(result.coverage.issues).toContain("Workspace text inventory exceeds 64 MiB")
  expect(result.coverage.excluded).toContainEqual({ path: "z/binary.txt", reason: "binary or non UTF8" })
  expect(result.coverage).toMatchObject({ fileHint: { admission: "not-admitted", priorityApplied: true, sourceHash: null, reason: "binary or non UTF8" } })
}, 60_000)

it("keeps ignored, generated, environment and linked source outside hinted admission", async () => {
  put("a/companion.txt", "priorityNeedle\n")
  put(".gitignore", "private/\n")
  for (const file of ["private/hidden.ts", "dist/generated.ts", ".env"]) put(file, targetText)
  writeFileSync(join(directory, "outside.ts"), targetText)
  symlinkSync(join(directory, "outside.ts"), join(root, "linked.ts"))
  for (const file of ["private/hidden.ts", "dist/generated.ts", ".env", "linked.ts"]) {
    const result = await search(file)
    expect(result.results.map(item => item.source)).toEqual([join(root, "a/companion.txt")])
    expect(result.coverage).toMatchObject({ fileHint: { admission: "not-admitted", priorityApplied: false, sourceHash: null } })
  }
  await expect(search("../outside.ts")).rejects.toThrow("file must be within workspaceRoot")
})

it("does not let a file hint opt unselected source or ancestor identity metadata into saved scope", async () => {
  put("package.json", JSON.stringify({ name: "root", workspaces: ["apps/*"] }))
  for (const name of ["web", "api"]) {
    put(`apps/${name}/package.json`, JSON.stringify({ name }))
    put(`apps/${name}/index.ts`, targetText)
  }
  put(".typelatch/scope.json", JSON.stringify({ version: 1, projects: ["apps/web"] }))
  for (const file of ["apps/api/index.ts", "package.json"]) {
    const result = await search(file)
    expect(result.results.map(item => item.source)).toEqual([join(root, "apps/web/index.ts")])
    expect(result.coverage).toMatchObject({ fileHint: { admission: "not-admitted", priorityApplied: false, sourceHash: null } })
  }
  put(".typelatch/scope.json", JSON.stringify({ version: 1, projects: [] }))
  expect((await search("apps/web/index.ts")).coverage.files).toBe(0)
})

it("reports refreshed hinted content and drops ignored content from the same root cache", async () => {
  put("a/companion.txt", "priorityNeedle\n")
  put("z/target.ts", targetText)
  const before = await search("z/target.ts")
  expect((await search("z/target.ts")).index?.updatedFiles).toBe(0)
  const original = statSync(join(root, "z/target.ts"))
  const changed = targetText.replace("return 1", "return 2")
  put("z/target.ts", changed)
  utimesSync(join(root, "z/target.ts"), original.atime, original.mtime)
  const refreshed = await search("z/target.ts")
  expect(refreshed.index?.path).toBe(before.index?.path)
  expect(refreshed.index?.snapshot).not.toBe(before.index?.snapshot)
  expect(refreshed.index?.updatedFiles).toBe(1)
  expect(refreshed.results.find(item => item.source === join(root, "z/target.ts"))?.snippet).toContain("return 2")
  expect(refreshed.coverage).toMatchObject({ fileHint: { sourceHash: createHash("sha256").update(changed).digest("hex") } })
  put(".gitignore", "z/target.ts\n")
  const ignored = await search("z/target.ts")
  expect(ignored.index?.removedFiles).toBe(1)
  expect(ignored.results.map(item => item.source)).toEqual([join(root, "a/companion.txt")])
  expect(ignored.coverage).toMatchObject({ fileHint: { admission: "not-admitted", priorityApplied: false, sourceHash: null } })
})

it("keeps fallback priority disabled and dependency-only output unchanged", async () => {
  put("a/companion.txt", "priorityNeedle\n")
  put("z/target.ts", targetText)
  const dependencyOnly = await search("z/target.ts", "dependencies")
  expect(dependencyOnly.index).toBeNull()
  expect(dependencyOnly.coverage).not.toHaveProperty("fileHint")
  rmSync(join(root, ".git"), { recursive: true })
  const fallback = await search("z/target.ts")
  expect(fallback.coverage).toMatchObject({ fileHint: { admission: "admitted", priorityApplied: false } })
  expect(fallback.coverage.issues).toContain("Git file selection unavailable; filesystem traversal does not apply Git ignore rules")
})
