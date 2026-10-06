import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { resolveProjectLockfile } from "../src/project.js"
import { planSync } from "../src/sync.js"

let root: string
let previousHome: string | undefined
const put = (path: string, value: object | string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const npmLock = (packages: Record<string, { version: string; integrity?: string; name?: string }>) => ({ lockfileVersion: 3, packages })
const manifest = (name: string, dependencies: Record<string, string> = {}) => ({ name, dependencies })
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-sync-")))
  mkdirSync(join(root, ".git"))
  previousHome = process.env.TYPELATCH_HOME
  process.env.TYPELATCH_HOME = join(root, ".cache")
  put("package.json", manifest("root", { effect: "^3.0.0" }))
  put("package-lock.json", npmLock({ "node_modules/effect": { version: "3.22.1", integrity: "sha512-first" } }))
})
afterEach(() => {
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

it("defaults to the current manifest and reports cache evidence without downloading", async () => {
  put("apps/web/package.json", manifest("web", { other: "1.0.0" }))
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(true)
  expect(plan.projects).toEqual([{ root, lockfile: join(root, "package-lock.json") }])
  expect(plan.targets).toEqual([{ name: "effect", version: "3.22.1", integrity: "sha512-first", cache: "missing", sources: [{ project: root, lockfile: join(root, "package-lock.json"), alias: "effect" }] }])
})

it("expands declared workspaces, retains different versions and deduplicates identical artifacts", async () => {
  put("package.json", { ...manifest("root", { effect: "^3.0.0" }), workspaces: { packages: ["apps/*", "packages/*", "!packages/ignored"] } })
  put("apps/web/package.json", manifest("web", { effect: "^3.0.0" }))
  put("apps/legacy/package.json", manifest("legacy", { effect: "^2.0.0" }))
  put("apps/legacy/package-lock.json", npmLock({ "node_modules/effect": { version: "2.0.0" } }))
  put("packages/ignored/package.json", manifest("ignored", { missing: "1.0.0" }))
  put("scratch/package.json", manifest("scratch", { missing: "1.0.0" }))
  const plan = await planSync({ cwd: root, workspaces: true })
  expect(plan.ready).toBe(true)
  expect(plan.projects.map(item => item.root)).toEqual([root, join(root, "apps/legacy"), join(root, "apps/web")])
  expect(plan.targets.map(item => `${item.name}@${item.version}`)).toEqual(["effect@2.0.0", "effect@3.22.1"])
  expect(plan.targets[1]?.sources).toHaveLength(2)
})

it("accepts pnpm workspace globs and an empty root manifest without a root lock", async () => {
  put("package.json", { name: "root" })
  rmSync(join(root, "package-lock.json"))
  put("pnpm-workspace.yaml", "packages:\n  - 'apps/**'\n  - '!apps/excluded'\n")
  put("apps/web/package.json", manifest("web", { effect: "3.22.1" }))
  put("apps/web/pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      effect: {specifier: 3.22.1, version: 3.22.1}\npackages:\n  effect@3.22.1: {}\n")
  put("apps/excluded/package.json", manifest("excluded", { missing: "1.0.0" }))
  const plan = await planSync({ cwd: root, workspaces: true })
  expect(plan.ready).toBe(true)
  expect(plan.projects).toHaveLength(2)
  expect(plan.targets[0]).toMatchObject({ name: "effect", version: "3.22.1" })
})

it("repeated explicit projects replace the default manifest", async () => {
  put("package.json", manifest("root", { broken: "1.0.0" }))
  put("apps/a/package.json", manifest("a", { effect: "3.22.1" }))
  put("apps/b/package.json", manifest("b", { effect: "3.22.1" }))
  const plan = await planSync({ cwd: root, projects: ["apps/a", "apps/b", "apps/a"] })
  expect(plan.ready).toBe(true)
  expect(plan.projects.map(item => item.root)).toEqual([join(root, "apps/a"), join(root, "apps/b")])
  expect(plan.targets[0]?.sources).toHaveLength(2)
})

it("filters before unrelated lock resolution failures and accepts registry names and aliases", async () => {
  put("package.json", { dependencies: { alias: "npm:effect@^3.0.0", missing: "1.0.0", local: "workspace:*" } })
  put("package-lock.json", npmLock({ "node_modules/alias": { name: "effect", version: "3.22.1" } }))
  for (const name of ["alias", "effect"]) {
    const plan = await planSync({ cwd: root, packages: [name] })
    expect(plan.ready).toBe(true)
    expect(plan.targets).toHaveLength(1)
  }
  const unknown = await planSync({ cwd: root, packages: ["unknown"] })
  expect(unknown.ready).toBe(false)
  expect(unknown.issues.join(" ")).toContain("Unknown requested dependency: unknown")
})

it("skips unrelated projects before inspecting their competing lockfiles", async () => {
  put("apps/broken/package.json", manifest("broken", { unrelated: "1.0.0" }))
  put("apps/broken/package-lock.json", "malformed")
  put("apps/broken/yarn.lock", "malformed")
  const plan = await planSync({ cwd: root, projects: [".", "apps/broken"], packages: ["effect"] })
  expect(plan.ready).toBe(true)
  expect(plan.targets).toHaveLength(1)
})

it("reports local dependencies as skipped", async () => {
  put("package.json", manifest("root", { local: "workspace:*", linked: "file:../linked", effect: "^3.0.0" }))
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(true)
  expect(plan.skipped.map(item => item.name)).toEqual(["linked", "local"])
})

it("blocks all downloads on conflicting integrity for the same name and version", async () => {
  put("apps/web/package.json", manifest("web", { effect: "3.22.1" }))
  put("apps/web/package-lock.json", npmLock({ "node_modules/effect": { version: "3.22.1", integrity: "sha512-second" } }))
  const plan = await planSync({ cwd: root, projects: [".", "apps/web"] })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("Conflicting integrity for effect@3.22.1")
})

it("reports ambiguity and supports a single-project explicit ancestor lockfile", async () => {
  put("yarn.lock", 'effect@^3.0.0:\n  version "3.22.1"\n')
  expect((await planSync({ cwd: root })).ready).toBe(false)
  const plan = await planSync({ cwd: root, lockfile: "package-lock.json" })
  expect(plan.ready).toBe(true)
  expect(plan.projects[0]?.lockfile).toBe(join(root, "package-lock.json"))
  put("apps/web/package.json", manifest("web", { effect: "^3.0.0" }))
  expect((await planSync({ cwd: root, projects: ["apps/web"], lockfile: "package-lock.json" })).ready).toBe(true)
  expect((await planSync({ cwd: root, projects: [".", "apps/web"], lockfile: "package-lock.json" })).ready).toBe(false)
  expect((await planSync({ cwd: root, workspaces: true, projects: ["apps/web"] })).ready).toBe(false)
})

it("validates cached metadata instead of treating any existing database as ready", async () => {
  const path = brainPath("effect", "3.22.1")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "invalid database")
  expect((await planSync({ cwd: root })).targets[0]?.cache).toBe("invalid")
  rmSync(path)
  const db = createBrainDatabase(path)
  const insert = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
  for (const [key, value] of Object.entries({ package: "effect", version: "3.22.1", integrity: "sha512-first", schemaVersion: "2", format: "compact" })) insert.run(key, value)
  db.close()
  expect((await planSync({ cwd: root })).targets[0]?.cache).toBe("ready")
  expect((await planSync({ cwd: root, force: true })).targets[0]?.cache).toBe("ready")
  put("package-lock.json", npmLock({ "node_modules/effect": { version: "3.22.1", integrity: "sha512-different" } }))
  expect((await planSync({ cwd: root })).targets[0]?.cache).toBe("invalid")
})

it("resolves shared lock ownership from observed reads and never crosses its boundary", async () => {
  const observed = new Map([
    [join(root, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0" })],
    [join(root, "package-lock.json"), JSON.stringify(npmLock({ "node_modules/effect": { version: "3.22.1" } }))],
    [join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages: {}\n"],
    [join(root, "apps/web/package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0" })],
  ])
  const reads: string[] = []
  const read = async (path: string) => { reads.push(path); return observed.get(path) }
  const lock = await resolveProjectLockfile(join(root, "apps/web"), root, read)
  expect(lock?.path).toBe(join(root, "pnpm-lock.yaml"))
  expect(reads.every(path => path.startsWith(`${root}/`))).toBe(true)
  expect(await resolveProjectLockfile(join(root, "apps/web"), join(root, "apps"), read)).toBeUndefined()
})

it("does not inherit an unrelated parent lock outside the repository", async () => {
  put("nested/.git/keep", "")
  put("nested/package.json", manifest("nested", { effect: "^3.0.0" }))
  const plan = await planSync({ cwd: join(root, "nested") })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("No supported lockfile")
})

it("skips npm semver workspace links instead of selecting a hoisted registry name", async () => {
  put("package.json", { workspaces: ["apps/*"], dependencies: { local: "^1.0.0" } })
  put("apps/local/package.json", { name: "local", version: "1.0.0" })
  put("package-lock.json", { lockfileVersion: 3, packages: { "node_modules/local": { resolved: "apps/local", link: true } } })
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(true)
  expect(plan.targets).toEqual([])
  expect(plan.skipped).toEqual([{ project: root, name: "local", reason: "Local or workspace dependency" }])
})

it("an independent nested lock owns resolution despite the root package manager", async () => {
  put("package.json", { packageManager: "pnpm@10.0.0" })
  put("apps/web/package.json", manifest("web", { effect: "1.0.0" }))
  put("apps/web/package-lock.json", npmLock({ "node_modules/effect": { version: "1.0.0" } }))
  const plan = await planSync({ cwd: root, projects: ["apps/web"] })
  expect(plan.ready).toBe(true)
  expect(plan.targets[0]?.version).toBe("1.0.0")
})

it("explicit projects also stop at a nested repository boundary", async () => {
  put("nested/.git/keep", "")
  put("nested/package.json", manifest("nested", { effect: "^3.0.0" }))
  const plan = await planSync({ cwd: root, projects: ["nested"] })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("No supported lockfile")
})

it("rejects lockfile overrides in unrelated sibling directories", async () => {
  put("apps/web/package.json", manifest("web", { effect: "1.0.0" }))
  put("apps/api/package-lock.json", npmLock({ "node_modules/effect": { version: "1.0.0" } }))
  const plan = await planSync({ cwd: root, projects: ["apps/web"], lockfile: "apps/api/package-lock.json" })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("Lockfile must belong to the project or an ancestor")
})

it("skips declared Yarn Classic local workspaces only when the version satisfies the dependency", async () => {
  rmSync(join(root, "package-lock.json"))
  put("package.json", { workspaces: ["apps/*"], dependencies: { local: "^1.0.0", external: "^2.0.0" } })
  put("apps/local/package.json", { name: "local", version: "1.2.0" })
  put("apps/external/package.json", { name: "external", version: "1.0.0" })
  put("yarn.lock", '# yarn lockfile v1\n\nexternal@^2.0.0:\n  version "2.0.0"\n')
  const plan = await planSync({ cwd: root })
  expect(plan.ready, JSON.stringify(plan)).toBe(true)
  expect(plan.targets.map(item => item.name)).toEqual(["external"])
  expect(plan.skipped.map(item => item.name)).toEqual(["local"])
  put("package.json", { workspaces: ["apps/*"], dependencies: { local: "^3.0.0" } })
  expect((await planSync({ cwd: root })).ready).toBe(false)
})

it("pnpm workspace configuration is authoritative even when packages is omitted", async () => {
  put("package.json", { name: "root", workspaces: ["apps/*"] })
  put("pnpm-workspace.yaml", "onlyBuiltDependencies: []\n")
  put("apps/web/package.json", manifest("web", { missing: "1.0.0" }))
  const plan = await planSync({ cwd: root, workspaces: true })
  expect(plan.ready).toBe(true)
  expect(plan.projects.map(item => item.root)).toEqual([root])
})

it("workspace globs exclude dot directories unless named explicitly", async () => {
  put("package.json", { name: "root", workspaces: ["apps/*", "packages/.included"] })
  put("apps/.hidden/package.json", manifest("hidden", { missing: "1.0.0" }))
  put("packages/.included/package.json", manifest("included"))
  const plan = await planSync({ cwd: root, workspaces: true })
  expect(plan.ready).toBe(true)
  expect(plan.projects.map(item => item.root)).toEqual([root, join(root, "packages/.included")])
})

it("Bun workspace-specific registry dependencies beat a hoisted local workspace", async () => {
  put("apps/web/package.json", manifest("app", { local: "^2.0.0" }))
  put("bun.lock", { lockfileVersion: 1, workspaces: { "apps/web": { name: "app" }, "packages/local": { name: "local", version: "1.0.0" } }, packages: {
    app: ["app@workspace:apps/web"], local: ["local@workspace:packages/local"], "app/local": ["local@2.0.0", "", {}, "sha512-fixture"],
  } })
  rmSync(join(root, "package-lock.json"))
  const plan = await planSync({ cwd: root, projects: ["apps/web"] })
  expect(plan.ready).toBe(true)
  expect(plan.targets[0]).toMatchObject({ name: "local", version: "2.0.0" })
  expect(plan.skipped).toEqual([])
})

it("lock format priority does not turn independent nested locks into competing managers", async () => {
  put("package.json", { name: "root", packageManager: "pnpm@10.0.0" })
  put("apps/web/package.json", manifest("web", { effect: "1.0.0" }))
  put("apps/web/package-lock.json", npmLock({ "node_modules/effect": { version: "9.0.0" } }))
  put("apps/web/npm-shrinkwrap.json", npmLock({ "node_modules/effect": { version: "1.0.0" } }))
  const plan = await planSync({ cwd: root, projects: ["apps/web"] })
  expect(plan.ready).toBe(true)
  expect(plan.targets[0]?.version).toBe("1.0.0")
})
