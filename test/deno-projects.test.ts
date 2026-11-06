import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { projectDependencies } from "../src/project.js"
import { readScope, updateScope } from "../src/scope.js"
import { planSync } from "../src/sync.js"
import { inventoryWorkspace } from "../src/workspace/inventory.js"

let root: string
const put = (path: string, value: object | string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const lock = () => ({ version: "4", specifiers: { "npm:effect@^3": "3.22.1", "npm:effect@^4": "4.0.0", "npm:chalk@5": "5.6.2" }, npm: {
  "effect@3.22.1": { integrity: "sha512-effect3" }, "effect@4.0.0": { integrity: "sha512-effect4" }, "chalk@5.6.2": { integrity: "sha512-chalk" },
} })
const inventory = () => inventoryWorkspace(root, true, new AbortController().signal)
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-deno-projects-")))
  execFileSync("git", ["init", "-q", root])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("syncs JSONC npm import aliases and subpaths through their exact Deno selectors", async () => {
  put("deno.jsonc", '{ // aliases are import specifiers, not installation names\n "imports": { "fx/Schema": "npm:effect@^3/Schema", "color": "npm:chalk@5" },\n}')
  put("deno.lock", lock())
  const plan = await planSync({ cwd: root })
  expect(plan.issues).toEqual([])
  expect(plan.ready).toBe(true)
  expect(plan.targets.map(target => `${target.name}@${target.version}`)).toEqual(["chalk@5.6.2", "effect@3.22.1"])
  expect(await projectDependencies(root)).toEqual([{ name: "chalk", version: "5.6.2", alias: "color" }, { name: "effect", version: "3.22.1", alias: "fx/Schema" }])
  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.projects).toEqual([root])
  expect(result.files.find(file => file.path === join(root, "deno.lock"))?.searchable).toBe(false)
})

it("discovers native Deno workspaces and inherits root imports for saved member scope", async () => {
  put("deno.json", { workspace: ["./apps/*"], imports: { effect: "npm:effect@^3", color: "npm:chalk@5" } })
  put("deno.lock", lock())
  put("apps/web/deno.json", { name: "@local/web", imports: { effect: "npm:effect@^4" } })
  put("apps/web/main.ts", "export const web = true")
  put("apps/api/deno.jsonc", '{"name":"@local/api"}')
  put("apps/api/main.ts", "export const api = true")
  expect((await planSync({ cwd: root, workspaces: true })).projects.map(project => project.root)).toEqual([root, join(root, "apps/api"), join(root, "apps/web")])
  rmSync(join(root, ".git"), { recursive: true })
  const scope = await updateScope(join(root, "apps/web"), "set", ["."])
  expect(scope.root).toBe(root)
  expect((await readScope(join(root, "apps/web")))?.projects).toEqual([join(root, "apps/web")])
  execFileSync("git", ["init", "-q", root])
  const plan = await planSync({ cwd: root })
  expect(plan.issues).toEqual([])
  expect(plan.targets.map(target => `${target.name}@${target.version}`)).toEqual(["chalk@5.6.2", "effect@4.0.0"])
  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.dependencies.map(item => `${item.package}@${item.version}`)).toEqual(["chalk@5.6.2", "effect@4.0.0"])
  expect(result.files.filter(file => file.searchable).map(file => file.path)).not.toContain(join(root, "apps/api/main.ts"))
  expect(result.files.find(file => file.path === join(root, "deno.json"))?.searchable).toBe(false)
})

it.each([
  [{ imports: { remote: "https://example.invalid/mod.ts" } }, /Unsupported Deno import.*remote/],
  [{ imports: { std: "jsr:@std/assert@1" } }, /Unsupported Deno import.*std/],
  [{ importMap: "./imports.json" }, /Unsupported Deno importMap/],
  [{ scopes: { "./src/": { effect: "npm:effect@^3" } } }, /Unsupported Deno scopes/],
  [{ lock: false, imports: { effect: "npm:effect@^3" } }, /Deno lockfile is disabled/],
  [{ lock: "./custom.lock", imports: { effect: "npm:effect@^3" } }, /Unsupported Deno lockfile path/],
])("reports unsupported Deno resolution instead of claiming complete coverage: %j", async (manifest, diagnostic) => {
  put("deno.json", manifest)
  put("deno.lock", lock())
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toMatch(diagnostic)
  expect((await inventory()).issues.join(" ")).toMatch(diagnostic)
})

it("does not inherit undeclared ancestor imports or cross nested Git boundaries", async () => {
  put("deno.json", { workspace: ["apps/*"], imports: { effect: "npm:effect@^3" } })
  put("deno.lock", lock())
  put("other/deno.json", {})
  put("apps/nested/deno.json", {})
  mkdirSync(join(root, "apps/nested/.git"))
  expect((await planSync({ cwd: join(root, "other") })).targets).toEqual([])
  expect((await planSync({ cwd: join(root, "apps/nested") })).targets).toEqual([])
})

it("keeps local and builtin imports out of registry package targets", async () => {
  put("deno.json", { imports: { local: "./src/mod.ts", fs: "node:fs", fx: "npm:effect@^3" } })
  put("deno.lock", lock())
  const plan = await planSync({ cwd: root })
  expect(plan.issues).toEqual([])
  expect(plan.targets.map(target => target.name)).toEqual(["effect"])
  expect(plan.skipped.map(item => item.name)).toEqual(["fs", "local"])
})


it("combines nonconflicting package.json dependencies with Deno imports", async () => {
  put("package.json", { dependencies: { chalk: "5" } })
  put("deno.json", { imports: { fx: "npm:effect@^3" } })
  put("deno.lock", lock())
  const plan = await planSync({ cwd: root })
  expect(plan.issues).toEqual([])
  expect(plan.targets.map(target => `${target.name}@${target.version}`)).toEqual(["chalk@5.6.2", "effect@3.22.1"])
  expect((await inventory()).projects).toEqual([root])
})

it.each(["deno.json", "deno.jsonc"])("previews a %s project through the real CLI without a package manifest", file => {
  put(file, '{ /* npm discovery */ "imports": {"fx": "npm:effect@^3"} }')
  put("deno.lock", lock())
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "sync", "--dry-run", "--json"], {
    cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, TYPELATCH_HOME: join(root, "cache") },
  })
  expect(result.status, result.stderr).toBe(0)
  const plan = JSON.parse(result.stdout)
  expect(plan.ready).toBe(true)
  expect(plan.targets).toMatchObject([{ name: "effect", version: "3.22.1", cache: "missing" }])
  expect(plan.projects).toEqual([{ root, lockfile: join(root, "deno.lock") }])
})

it.each([["npm:effect/Schema", "effect"], ["npm:@demo/fx/Schema", "@demo/fx"]])("selects the package behind versionless subpath %s", async (specifier, name) => {
  put("deno.json", { imports: { schema: specifier } })
  put("deno.lock", { version: "4", specifiers: { [`npm:${name}@*`]: "1.2.3" }, npm: { [`${name}@1.2.3`]: { integrity: "sha512-fixture" } } })
  const plan = await planSync({ cwd: root, packages: [name] })
  expect(plan.issues).toEqual([])
  expect(plan.targets.map(target => target.name)).toEqual([name])
})

it("does not resolve Deno import aliases through an explicitly selected npm lock tree", async () => {
  put("package.json", { packageManager: "npm@11.0.0" })
  put("deno.json", { imports: { fx: "npm:effect@^3" } })
  put("package-lock.json", { lockfileVersion: 3, packages: { "node_modules/fx": { name: "unrelated", version: "9.0.0" } } })
  put("deno.lock", lock())
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(false)
  expect(plan.targets).toEqual([])
  expect(plan.issues.join(" ")).toContain("Deno npm imports require deno.lock")
  await expect(projectDependencies(root)).rejects.toThrow("Deno npm imports require deno.lock")
  expect((await inventory()).issues.join(" ")).toContain("Deno npm imports require deno.lock")
})

it("reports a package declaration that conflicts with an inherited Deno import", async () => {
  put("deno.json", { workspace: ["apps/*"], imports: { effect: "npm:effect@^3" } })
  put("deno.lock", lock())
  put("apps/web/package.json", { dependencies: { effect: "^4" } })
  const plan = await planSync({ cwd: join(root, "apps/web") })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("Conflicting package.json and inherited Deno import effect")
  expect(plan.targets).toEqual([])
})

it.each(["deno.json", "deno.jsonc"])("preserves npm ownership when %s only configures formatting", async file => {
  put("package.json", { dependencies: { effect: "^3" } })
  put("package-lock.json", { lockfileVersion: 3, packages: { "node_modules/effect": { version: "3.22.1" } } })
  put(file, { fmt: { semiColons: false } })
  const plan = await planSync({ cwd: root })
  expect(plan.issues).toEqual([])
  expect(plan.ready).toBe(true)
  expect(plan.projects).toEqual([{ root, lockfile: join(root, "package-lock.json") }])
  expect(await projectDependencies(root)).toEqual([{ name: "effect", version: "3.22.1" }])
  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.dependencies).toMatchObject([{ package: "effect", version: "3.22.1", identity: "lockfile" }])
})

it("uses Deno workspace declarations instead of unrelated pnpm workspace metadata", async () => {
  put("deno.json", { workspace: ["deno-app"], imports: { effect: "npm:effect@^3" } })
  put("deno.lock", lock())
  put("deno-app/deno.json", {})
  put("old-node-app/package.json", {})
  put("pnpm-workspace.yaml", "packages:\n  - old-node-app\n")
  const plan = await planSync({ cwd: root, workspaces: true })
  expect(plan.issues).toEqual([])
  expect(plan.projects.map(project => project.root)).toEqual([root, join(root, "deno-app")])
  rmSync(join(root, ".git"), { recursive: true })
  expect((await updateScope(join(root, "deno-app"), "set", ["."])).root).toBe(root)
})
