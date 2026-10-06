import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { inventoryWorkspace } from "../src/workspace/inventory.js"

let root: string
const put = (path: string, value: string | object) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const inventory = () => inventoryWorkspace(root, true, new AbortController().signal)
const npm = (version: string) => ({ lockfileVersion: 3, packages: { "node_modules/effect": { version } } })
const pnpm = (importer: string, version: string) => `lockfileVersion: '9.0'
importers:
  ${importer}:
    dependencies:
      effect:
        version: ${version}
packages:
  effect@${version}:
    resolution: {integrity: sha512-fixture}
  helper@1.0.0:
    resolution: {integrity: sha512-helper}
`

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-sync-inventory-")))
  execFileSync("git", ["init", "-q", root])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("uses each project's packageManager to select a shared ancestor lockfile", async () => {
  put("package.json", { packageManager: "npm@11.0.0", dependencies: { effect: "^3.0.0" } })
  put("packages/app/package.json", { packageManager: "pnpm@10.0.0", dependencies: { effect: "^4.0.0" } })
  put("package-lock.json", npm("3.22.1"))
  put("pnpm-lock.yaml", pnpm("packages/app", "4.0.0"))

  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.dependencies).toEqual(expect.arrayContaining([
    expect.objectContaining({ package: "effect", version: "3.22.1", identity: "lockfile" }),
    expect.objectContaining({ package: "effect", version: "4.0.0", identity: "lockfile", roots: [join(root, "packages/app/node_modules/effect")] }),
    expect.objectContaining({ package: "helper", version: "1.0.0", identity: "lockfile" }),
  ]))
})

it("retains transitive identities when projects select competing lock installation trees", async () => {
  put("package.json", { packageManager: "npm@11.0.0", dependencies: { effect: "^3.0.0" } })
  put("apps/web/package.json", { packageManager: "bun@1.3.0", dependencies: { effect: "^4.0.0" } })
  put("package-lock.json", { lockfileVersion: 3, packages: {
    "node_modules/effect": { version: "3.22.1" },
    "node_modules/helper": { version: "1.0.0" },
  } })
  put("bun.lock", { lockfileVersion: 1, packages: {
    effect: ["effect@4.0.0"],
    helper: ["helper@2.0.0"],
  } })

  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.dependencies.map(item => `${item.package}@${item.version}`)).toEqual(["effect@3.22.1", "effect@4.0.0", "helper@1.0.0", "helper@2.0.0"])
  expect(result.dependencies.find(item => item.package === "helper" && item.version === "2.0.0")).toMatchObject({ identity: "lockfile", installed: false, roots: [join(root, "bun.lock")] })
})

it("stops at an independent nested lock before consulting an ancestor packageManager", async () => {
  put("package.json", { packageManager: "npm@11.0.0", dependencies: { effect: "^3.0.0" } })
  put("package-lock.json", npm("3.22.1"))
  put("apps/web/package.json", { dependencies: { effect: "^4.0.0" } })
  put("apps/web/pnpm-lock.yaml", pnpm(".", "4.0.0"))

  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.dependencies.map(item => `${item.package}@${item.version}`)).toEqual(["effect@3.22.1", "effect@4.0.0", "helper@1.0.0"])
})

it("reports competing nested locks instead of falling back to an ancestor lock", async () => {
  put("package.json", { dependencies: { effect: "^3.0.0" } })
  put("package-lock.json", npm("3.22.1"))
  put("apps/web/package.json", { dependencies: { effect: "^4.0.0" } })
  put("apps/web/package-lock.json", npm("4.0.0"))
  put("apps/web/pnpm-lock.yaml", pnpm(".", "4.0.0"))

  const result = await inventory()
  expect(result.issues.join(" ")).toContain("Ambiguous lockfiles")
  expect(result.dependencies.map(item => `${item.package}@${item.version}`)).toEqual(["effect@3.22.1"])
})

it("uses an ancestor packageManager to disambiguate competing nested locks", async () => {
  put("package.json", { packageManager: "npm@11.0.0", dependencies: { effect: "^3.0.0" } })
  put("package-lock.json", npm("3.22.1"))
  put("apps/web/package.json", { dependencies: { effect: "^4.0.0" } })
  put("apps/web/package-lock.json", npm("4.0.0"))
  put("apps/web/pnpm-lock.yaml", pnpm(".", "4.1.0"))

  const result = await inventory()
  expect(result.issues).toEqual([])
  expect(result.dependencies.map(item => `${item.package}@${item.version}`)).toEqual(["effect@3.22.1", "effect@4.0.0"])
})

it("uses only observed files within the requested root", async () => {
  put("package.json", { dependencies: { effect: "^3.0.0" } })
  put("package-lock.json", npm("3.22.1"))
  put("apps/web/package.json", { dependencies: { effect: "^4.0.0" } })
  const result = await inventoryWorkspace(join(root, "apps/web"), true, new AbortController().signal)
  expect(result.dependencies).toEqual([])
  expect(result.issues.join(" ")).toContain("No exact installed or locked identity for effect")

  put(".gitignore", "pnpm-lock.yaml\n")
  put("apps/web/pnpm-lock.yaml", pnpm(".", "4.0.0"))
  const observed = await inventory()
  expect(observed.dependencies.map(item => `${item.package}@${item.version}`)).toEqual(["effect@3.22.1"])
})

it.each(["directory", "file"])("does not inherit identities across a nested .git %s boundary", async marker => {
  put("package.json", { dependencies: { effect: "^3.0.0" } })
  put("package-lock.json", npm("3.22.1"))
  put("nested/package.json", { dependencies: { effect: "^4.0.0" } })
  execFileSync("git", ["-C", root, "add", "."])
  if (marker === "directory") mkdirSync(join(root, "nested/.git"))
  else put("nested/.git", "gitdir: /outside/never-read\n")

  const result = await inventory()
  expect(result.projects).toContain(join(root, "nested"))
  expect(result.issues).toContain(`No exact installed or locked identity for effect in ${join(root, "nested")}`)
  expect(result.dependencies).toEqual([expect.objectContaining({ package: "effect", version: "3.22.1", roots: [join(root, "node_modules/effect")] })])
})

it("does not treat ancestor lock installation paths inside a nested repository as its identities", async () => {
  put("package.json", { dependencies: { effect: "^3.0.0" } })
  put("package-lock.json", { lockfileVersion: 3, packages: {
    "node_modules/effect": { version: "3.22.1" },
    "nested/node_modules/effect": { version: "4.0.0" },
  } })
  put("nested/package.json", { dependencies: { effect: "^5.0.0" } })
  execFileSync("git", ["-C", root, "add", "."])
  mkdirSync(join(root, "nested/.git"))

  const result = await inventory()
  expect(result.issues).toContain(`No exact installed or locked identity for effect in ${join(root, "nested")}`)
  expect(result.dependencies.find(item => item.version === "4.0.0")).toMatchObject({ identity: "lockfile", installed: false, roots: [join(root, "package-lock.json")] })
})
