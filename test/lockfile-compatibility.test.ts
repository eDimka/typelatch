import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import { afterEach, beforeEach, expect, it } from "vitest"
import { parseLockfile, selectLockfile } from "../src/lockfiles.js"
import { projectDependencies } from "../src/project.js"
import { planSync } from "../src/sync.js"
import { projectReader } from "../src/project-files.js"
import { inventoryWorkspace } from "../src/workspace/inventory.js"

let root: string
const put = (path: string, value: string | object) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-lock-compat-")))
  execFileSync("git", ["init", "-q", root])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each([0, 1, 2])("reads Bun %s catalog resolutions and aliases in JavaScript workspaces without tsconfig", async lockfileVersion => {
  put("package.json", { name: "root", workspaces: ["apps/*"], dependencies: { effect: "catalog:" } })
  put("apps/web/package.json", { name: "@demo/web", dependencies: { renamed: "catalog:legacy" } })
  put("apps/web/index.js", "export const value = 1\n")
  put("bun.lock", { lockfileVersion, configVersion: 1, catalog: { effect: "^3.0.0" }, catalogs: { legacy: { renamed: "npm:effect@^2.0.0" } }, workspaces: {
    "": { name: "root" }, "apps/web": { name: "@demo/web" },
  }, packages: {
    effect: ["effect@3.22.1", "", {}, "sha512-new"],
    "@demo/web": ["@demo/web@workspace:apps/web"],
    "@demo/web/renamed": ["effect@2.4.0", "", {}, "sha512-old"],
  } })
  const plan = await planSync({ cwd: root, workspaces: true })
  expect(plan.issues).toEqual([])
  expect(plan.targets.map(({ name, version, integrity }) => ({ name, version, integrity }))).toEqual([
    { name: "effect", version: "2.4.0", integrity: "sha512-old" }, { name: "effect", version: "3.22.1", integrity: "sha512-new" },
  ])
})

it.each(["package-lock.json", "npm-shrinkwrap.json"])("preserves v1 aliases and integrity in %s", async file => {
  put("package.json", { dependencies: { renamed: "npm:@demo/real@^1.0.0" } })
  put(file, { lockfileVersion: 1, dependencies: { renamed: { version: "npm:@demo/real@1.2.3", integrity: "sha512-alias" } } })
  expect(await projectDependencies(root)).toEqual([{ name: "@demo/real", version: "1.2.3", alias: "renamed" }])
  expect((await planSync({ cwd: root })).targets[0]?.integrity).toBe("sha512-alias")
})

it("reads ordinary npm 4 entries without claiming patched or repaired artifacts", () => {
  const lock = parseLockfile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 4, packages: {
    "node_modules/plain": { version: "1.0.0", integrity: "sha512-plain" },
    "node_modules/patched": { version: "1.0.0", patched: { path: "patches/pkg.patch", hash: "abc" } },
    "node_modules/repaired": { version: "1.0.0", packageExtensionsApplied: "abc" },
  } }))
  expect(lock.packages.map(item => item.name)).toEqual(["plain"])
  expect(lock.issues).toHaveLength(2)
})

it.each([5.3, 5.4, 6, 9])("preserves scoped aliases and underscores in pnpm %s", async version => {
  put("package.json", { dependencies: { renamed: "npm:@demo/under_score@^1.0.0" } })
  const key = version < 6 ? "/@demo/under_score/1.2.3_peer@2.0.0" : `${version === 6 ? "/" : ""}@demo/under_score@1.2.3(peer@2.0.0)`
  const dependency = version < 6 ? `'${key}'` : `{specifier: 'npm:@demo/under_score@^1.0.0', version: '${key}'}`
  put("pnpm-lock.yaml", `lockfileVersion: '${version}'\nimporters:\n  .:\n    dependencies:\n      renamed: ${dependency}\npackages:\n  '${key}':\n    resolution: {integrity: sha512-exact}\n`)
  expect(await projectDependencies(root)).toEqual([{ name: "@demo/under_score", version: "1.2.3", alias: "renamed" }])
})

it("resolves Yarn catalog descriptors through the observed root configuration", async () => {
  put("package.json", { workspaces: ["apps/*"] })
  put("apps/web/package.json", { dependencies: { effect: "catalog:", renamed: "catalog:legacy" } })
  put(".yarnrc.yml", "catalog:\n  effect: ^3.0.0\ncatalogs:\n  legacy:\n    renamed: npm:effect@^2.0.0\n")
  put("yarn.lock", `__metadata:\n  version: 8\n"effect@npm:^3.0.0":\n  version: 3.22.1\n  resolution: "effect@npm:3.22.1"\n"renamed@npm:effect@^2.0.0":\n  version: 2.4.0\n  resolution: "effect@npm:2.4.0"\n`)
  expect(await projectDependencies(join(root, "apps/web"))).toEqual([
    { name: "effect", version: "3.22.1" }, { name: "effect", version: "2.4.0", alias: "renamed" },
  ])
  const original = readFileSync(join(root, "yarn.lock"), "utf8")
  put(".yarnrc.yml", "catalog:\n  effect: ^4.0.0\n")
  await expect(projectDependencies(join(root, "apps/web"))).rejects.toThrow("No exact locked registry identity")
  expect(readFileSync(join(root, "yarn.lock"), "utf8")).toBe(original)
})

it("honors npm 12 package lock precedence while retaining legacy shrinkwrap support", () => {
  expect(selectLockfile(["package-lock.json", "npm-shrinkwrap.json"], "npm@12.2.1")).toBe("package-lock.json")
  expect(selectLockfile(["package-lock.json", "npm-shrinkwrap.json"], "npm@11.0.0")).toBe("npm-shrinkwrap.json")
  expect(() => selectLockfile(["npm-shrinkwrap.json"], "npm@12.2.1")).toThrow("No npm lockfile")
})

it("does not turn Git npm artifacts or unsupported local Bun tuples into registry packages", () => {
  const npm = parseLockfile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {
    "node_modules/git-package": { name: "git-package", version: "1.0.0", resolved: "git+https://example.com/repo.git#abc" },
  } }))
  expect(npm.packages).toEqual([])
  const bun = parseLockfile(join(root, "bun.lock"), JSON.stringify({ lockfileVersion: 2, packages: {
    local: ["local@file:../local@1", {}], link: ["link@link:../linked", {}],
  } }))
  expect(bun.packages).toEqual([])
  expect(bun.isLocal(root, "local", "catalog:")).toBe(true)
  expect(bun.isLocal(root, "link", "catalog:")).toBe(true)
})

it("reads pnpm catalog importer versions without interpreting the catalog as a version", async () => {
  put("package.json", { dependencies: { effect: "catalog:", renamed: "catalog:legacy" } })
  put("pnpm-lock.yaml", `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      effect: {specifier: 'catalog:', version: '3.22.1(peer@1.0.0)'}\n      renamed: {specifier: 'catalog:legacy', version: 'effect@2.4.0'}\npackages:\n  effect@3.22.1:\n    resolution: {integrity: sha512-new}\n  effect@2.4.0:\n    resolution: {integrity: sha512-old}\nsnapshots:\n  effect@3.22.1(peer@1.0.0): {}\n  effect@2.4.0: {}\n`)
  expect(await projectDependencies(root)).toEqual([
    { name: "effect", version: "3.22.1" }, { name: "effect", version: "2.4.0", alias: "renamed" },
  ])
})

it("retains only Yarn catalogs in observed metadata and never quotes secret configuration errors", async () => {
  put("package.json", { dependencies: { effect: "catalog:" } })
  put("yarn.lock", `__metadata:\n  version: 8\n"effect@npm:^3.0.0":\n  version: 3.22.1\n  resolution: "effect@npm:3.22.1"\n`)
  put(".yarnrc.yml", "npmAuthToken: private-fixture-secret\ncatalog:\n  effect: ^3.0.0\n")
  expect(await projectDependencies(root)).toEqual([{ name: "effect", version: "3.22.1" }])
  expect(await projectReader()(join(root, ".yarnrc.yml"))).not.toContain("private-fixture-secret")
  const inventory = await inventoryWorkspace(root, true, new AbortController().signal)
  expect(inventory.issues).toEqual([])
  expect(JSON.stringify(inventory)).not.toContain("private-fixture-secret")
  expect(inventory.files.find(file => file.path === join(root, ".yarnrc.yml"))?.searchable).toBe(false)
  put(".yarnrc.yml", "npmAuthToken: [private-fixture-secret\ncatalog: {effect: ^3.0.0}\n")
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("Invalid Yarn catalog configuration")
  expect(JSON.stringify(plan)).not.toContain("private-fixture-secret")
})
