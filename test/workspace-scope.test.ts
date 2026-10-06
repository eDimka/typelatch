import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { workspaceSearch } from "../src/workspace/search.js"
import { workspaceSearchAsync } from "../src/workspace/runtime.js"
import { retireIdleWorkers } from "../src/workspace/persistent.js"

let directory: string
let root: string
let previousHome: string | undefined
const put = (path: string, value: object | string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const save = (projects: string[]) => put(".typelatch/scope.json", { version: 1, projects })
const search = (question = "scopeMarker", extra = {}) => workspaceSearch({ workspaceRoot: root, question, scope: "workspace", ...extra })
beforeEach(() => {
  retireIdleWorkers()
  directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-workspace-scope-")))
  root = join(directory, "repo")
  mkdirSync(root)
  execFileSync("git", ["init", "-q", root])
  previousHome = process.env.TYPELATCH_HOME
  process.env.TYPELATCH_HOME = join(directory, "data")
  put("package.json", { name: "root", workspaces: ["apps/*"] })
  for (const name of ["web", "api"]) {
    put(`apps/${name}/package.json`, { name })
    put(`apps/${name}/index.ts`, `export function scopeMarker${name}() { return '${name}' }`)
  }
})
afterEach(() => {
  retireIdleWorkers()
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
})

it("adds projects without rebuilding unchanged source and removes stale results after contraction", async () => {
  save(["apps/web"])
  const first = await search()
  expect(first.results.map(item => item.symbol)).toEqual(["scopeMarkerweb"])
  expect(first.coverage.projects).toEqual([join(root, "apps/web")])
  expect(first.coverage.savedScope).toMatchObject({ path: join(root, ".typelatch/scope.json"), projects: [join(root, "apps/web")], dependencyPolicy: "direct" })
  expect((await search()).index?.updatedFiles).toBe(0)
  save(["apps/api", "apps/web"])
  const expanded = await search()
  expect(expanded.results.map(item => item.symbol).sort()).toEqual(["scopeMarkerapi", "scopeMarkerweb"])
  expect(expanded.index?.updatedFiles).toBe(2)
  save(["apps/api"])
  const contracted = await search()
  expect(contracted.results.map(item => item.symbol)).toEqual(["scopeMarkerapi"])
  expect(contracted.index?.removedFiles).toBe(2)
})

it("keeps an explicit empty selection empty and rejects invalid or stale saved scope", async () => {
  await search()
  save([])
  const empty = await search("scopeMarker", { scope: "all" })
  expect(empty.results).toEqual([])
  expect(empty.coverage).toMatchObject({ complete: true, files: 0, projects: [], dependencyCount: 0 })
  expect(empty.index?.removedFiles).toBeGreaterThan(0)
  put(".typelatch/scope.json", "broken")
  await expect(search()).rejects.toThrow(/scope/i)
  save(["apps/missing"])
  await expect(search()).rejects.toThrow()
})

it("reads only selected source before inventory limits and excludes ancestor metadata from search", async () => {
  save(["apps/web"])
  put("package.json", { name: "ancestorMetadataNeedle", dependencies: { ignored: "1.0.0" } })
  put("apps/api/package.json", "broken")
  put("apps/api/oversized.ts", "scopeMarker".repeat(110_000))
  for (let index = 0; index < 20_010; index++) put(`apps/api/noise/${index}.ts`, "")
  const selected = await search()
  expect(selected.results.map(item => item.symbol)).toEqual(["scopeMarkerweb"])
  expect(selected.coverage.complete).toBe(true)
  expect(selected.coverage.issues).toEqual([])
  expect(selected.coverage.files).toBe(2)
  expect((await search("ancestorMetadataNeedle")).results).toEqual([])
}, 20_000)

it("intersects scope with the requested root and honors literal project paths, ignores and source symlinks", async () => {
  put("apps/[chosen]/package.json", { name: "chosen" })
  put("apps/[chosen]/src/index.ts", "export const scopeMarkerLiteral = true")
  put("apps/[chosen]/private/hidden.ts", "export const scopeMarkerPrivate = true")
  put(".gitignore", "private/\n")
  symlinkSync(join(root, "apps/api"), join(root, "apps/[chosen]/linked"))
  save(["apps/[chosen]", "apps/web"])
  expect((await search()).results.map(item => item.symbol).sort()).toEqual(["scopeMarkerLiteral", "scopeMarkerweb"])
  const nested = await search("scopeMarker", { workspaceRoot: join(root, "apps/[chosen]/src") })
  expect(nested.results.map(item => item.symbol)).toEqual(["scopeMarkerLiteral"])
  expect(nested.coverage.projects).toEqual([])
  const outside = await search("scopeMarker", { workspaceRoot: join(root, "apps/api") })
  expect(outside.results).toEqual([])
  expect(outside.coverage.files).toBe(0)
})

it("bounds filesystem fallback to selected roots", async () => {
  rmSync(join(root, ".git"), { recursive: true })
  save(["apps/web"])
  put("apps/api/oversized.ts", "scopeMarker".repeat(110_000))
  const result = await search()
  expect(result.results.map(item => item.symbol)).toEqual(["scopeMarkerweb"])
  expect(result.coverage.issues).toEqual(["Git file selection unavailable; filesystem traversal does not apply Git ignore rules"])
  expect(result.coverage.files).toBe(2)
})

it("selects only direct dependencies, resolves hoisted aliases and preserves installed identity and integrity", async () => {
  save(["apps/web"])
  put("package.json", { name: "root", dependencies: { unrelated: "1.0.0" } })
  put("apps/web/package.json", { name: "web", dependencies: { alias: "npm:@scope/wire@1.0.0", locked: "2.0.0" } })
  put("apps/web/nested/package.json", { name: "nested", dependencies: { unrelated: "1.0.0" } })
  put("package-lock.json", " ".repeat(1_000_001) + JSON.stringify({ lockfileVersion: 3, packages: {
    "node_modules/alias": { name: "@scope/wire", version: "1.0.0", integrity: "sha512-wire" },
    "node_modules/locked": { version: "2.0.0", integrity: "sha512-locked" },
    "node_modules/unrelated": { version: "1.0.0" },
    "node_modules/transitive": { version: "3.0.0" },
    "node_modules/unsupported": { version: "not-a-version" }
  } }))
  put("node_modules/alias/package.json", { name: "@scope/wire", version: "1.0.0" })
  put("node_modules/alias/node_modules/transitive/package.json", { name: "transitive", version: "3.0.0" })
  put("node_modules/unrelated/package.json", "broken")
  const result = await search("send", { scope: "dependencies" })
  expect(result.coverage.dependencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ package: "@scope/wire", version: "1.0.0", identity: "installed", integrity: "sha512-wire" }),
    expect.objectContaining({ package: "locked", version: "2.0.0", identity: "lockfile", integrity: "sha512-locked" })
  ]))
  expect(result.coverage.dependencyCount).toBe(2)
  expect(result.coverage.issues).toEqual([])
  expect(result.coverage.projects).toEqual([join(root, "apps/web")])
  put("node_modules/alias/package.json", { name: "@scope/wire", version: "1.1.0" })
  const changed = await search("send", { scope: "dependencies" })
  expect(changed.coverage.dependencies.find(item => item.package === "@scope/wire")).toMatchObject({ version: "1.1.0", identity: "installed" })
  expect(changed.coverage.dependencies.find(item => item.package === "@scope/wire")?.integrity).toBeUndefined()
  expect(changed.coverage.issues).toEqual([`Installed dependency differs from lockfile: ${join(root, "node_modules/alias")}`])
})

it("keeps linked local workspace packages out of registry discovery and does not expand source selection", async () => {
  save(["apps/web"])
  put("apps/web/package.json", { name: "web", dependencies: { api: "workspace:*" } })
  mkdirSync(join(root, "node_modules"))
  symlinkSync(join(root, "apps/api"), join(root, "node_modules/api"))
  const result = await search("scopeMarker", { scope: "all" })
  expect(result.results.map(item => item.symbol)).toEqual(["scopeMarkerweb"])
  expect(result.coverage.dependencyCount).toBe(0)
  expect(result.coverage.issues).toEqual([])
})

it("corroborates Yarn Classic local ranges from declared workspace metadata without indexing sibling source", async () => {
  save(["apps/web"])
  put("package.json", { name: "root", workspaces: ["apps/*"] })
  put("apps/web/package.json", { name: "web", dependencies: { api: "^1.0.0" } })
  put("apps/api/package.json", { name: "api", version: "1.0.0" })
  put("apps/unrelated/package.json", "broken")
  put("yarn.lock", "# yarn lockfile v1\n")
  const result = await search("scopeMarker", { scope: "all" })
  expect(result.results.map(item => item.symbol)).toEqual(["scopeMarkerweb"])
  expect(result.coverage.projects).toEqual([join(root, "apps/web")])
  expect(result.coverage.files).toBe(2)
  expect(result.coverage.issues).toEqual([])
  expect(result.coverage.dependencyCount).toBe(0)
  put(".gitignore", "apps/api/\n")
  expect((await search("scopeMarker", { scope: "all" })).coverage.issues).toContain(`No exact installed or locked identity for api in ${join(root, "apps/web")}`)
  rmSync(join(root, ".gitignore"))
  mkdirSync(join(root, "apps/api/.git"))
  expect((await search("scopeMarker", { scope: "all" })).coverage.issues).toContain(`No exact installed or locked identity for api in ${join(root, "apps/web")}`)
})

it("reloads scope changes in the retained search worker", async () => {
  const request = { workspaceRoot: root, question: "scopeMarker", scope: "workspace" as const }
  save(["apps/web"])
  expect((await workspaceSearchAsync(request)).results.map(item => item.symbol)).toEqual(["scopeMarkerweb"])
  save(["apps/api"])
  expect((await workspaceSearchAsync(request)).results.map(item => item.symbol)).toEqual(["scopeMarkerapi"])
  save([])
  expect((await workspaceSearchAsync(request)).results).toEqual([])
  put(".typelatch/scope.json", "invalid")
  await expect(workspaceSearchAsync(request)).rejects.toThrow(/scope/i)
}, 15_000)
