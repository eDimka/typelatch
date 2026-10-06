import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { clearScope, readScope, resolveScopeProjects, updateScope } from "../src/scope.js"

let root: string
const put = (path: string, value: object | string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const path = () => join(root, ".typelatch/scope.json")
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-scope-")))
  mkdirSync(join(root, ".git"))
  put("package.json", { name: "root", workspaces: ["apps/*"] })
  put("apps/web/package.json", { name: "web" })
  put("apps/api/package.json", { name: "api" })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("has no implicit selection before saving and stores a portable explicit subset", async () => {
  expect(await readScope(root)).toBeNull()
  expect(await updateScope(root, "set", ["apps/web", "apps/web"])).toEqual({ root, path: path(), projects: [join(root, "apps/web")] })
  expect(JSON.parse(readFileSync(path(), "utf8"))).toEqual({ version: 1, projects: ["apps/web"] })
  expect(await readScope(join(root, "apps/api"))).toEqual({ root, path: path(), projects: [join(root, "apps/web")] })
})

it("adds paths from the command directory without replacing the saved subset", async () => {
  await updateScope(root, "set", ["apps/web"])
  const scope = await updateScope(join(root, "apps/web"), "add", ["../api", "."])
  expect(scope.projects).toEqual([join(root, "apps/api"), join(root, "apps/web")])
  expect(await resolveScopeProjects(scope)).toEqual(scope.projects)
  expect(JSON.parse(readFileSync(path(), "utf8"))).toEqual({ version: 1, projects: ["apps/api", "apps/web"] })
})

it("removing the last project persists an empty subset and clear removes the default", async () => {
  await updateScope(root, "set", ["apps/web"])
  expect((await updateScope(root, "remove", ["apps/web"])).projects).toEqual([])
  expect((await readScope(root))?.projects).toEqual([])
  expect(await clearScope(join(root, "apps/web"))).toEqual({ root, path: path(), removed: true })
  expect(await readScope(root)).toBeNull()
  expect(await clearScope(root)).toEqual({ root, path: path(), removed: false })
})

it("requires an existing scope before removing projects", async () => {
  await expect(updateScope(root, "remove", ["apps/web"])).rejects.toThrow("No saved scope")
  expect(await readScope(root)).toBeNull()
})

it("clears invalid nearest scope data so an inherited selection becomes readable", async () => {
  await updateScope(root, "set", ["apps/api"])
  const child = join(root, "apps/web")
  put("apps/web/.typelatch/scope.json", "invalid JSON")
  await expect(readScope(child)).rejects.toThrow("Invalid scope JSON")
  expect(await clearScope(child)).toEqual({ root: child, path: join(child, ".typelatch/scope.json"), removed: true })
  expect((await readScope(child))?.projects).toEqual([join(root, "apps/api")])
})

it("retains size checks when clearing invalid scope data", async () => {
  put(".typelatch/scope.json", "x".repeat(1024 * 1024 + 1))
  await expect(clearScope(root)).rejects.toThrow("Scope file exceeds 1 MiB")
  expect(readFileSync(path(), "utf8")).toHaveLength(1024 * 1024 + 1)
})

it("keeps stale selections readable and removable while explicit validation fails", async () => {
  await updateScope(root, "set", ["apps/web"])
  rmSync(join(root, "apps/web"), { recursive: true })
  const stale = await readScope(root)
  expect(stale?.projects).toEqual([join(root, "apps/web")])
  await expect(resolveScopeProjects(stale!)).rejects.toThrow(/project|directory/i)
  expect((await updateScope(root, "remove", ["apps/web"])).projects).toEqual([])
})

it("uses the nearest saved scope and stops at a nested repository boundary", async () => {
  await updateScope(root, "set", ["apps/api"])
  put("apps/web/.typelatch/scope.json", { version: 1, projects: ["."] })
  expect((await readScope(join(root, "apps/web")))?.root).toBe(join(root, "apps/web"))
  mkdirSync(join(root, "apps/web/.git"))
  rmSync(join(root, "apps/web/.typelatch"), { recursive: true })
  expect(await readScope(join(root, "apps/web"))).toBeNull()
  expect((await updateScope(join(root, "apps/web"), "set", ["."])).root).toBe(join(root, "apps/web"))
})

it("uses the declared workspace boundary outside Git", async () => {
  rmSync(join(root, ".git"), { recursive: true })
  expect((await updateScope(join(root, "apps/web"), "set", ["."])).root).toBe(root)
})

it("inherits workspace scope from a package source directory outside Git", async () => {
  rmSync(join(root, ".git"), { recursive: true })
  mkdirSync(join(root, "apps/web/src"))
  await updateScope(root, "set", ["apps/web"])
  expect((await readScope(join(root, "apps/web/src")))?.projects).toEqual([join(root, "apps/web")])
  expect((await updateScope(join(root, "apps/web/src"), "add", ["../../api"])).projects).toEqual([join(root, "apps/api"), join(root, "apps/web")])
})

it("does not cross a nested Git boundary while finding the owning package", async () => {
  await updateScope(root, "set", ["apps/web"])
  mkdirSync(join(root, "apps/web/nested/.git"), { recursive: true })
  mkdirSync(join(root, "apps/web/nested/src"))
  expect(await readScope(join(root, "apps/web/nested/src"))).toBeNull()
})

it.each([
  "not json",
  { version: 2, projects: [] },
  { version: 1, projects: "apps/web" },
  { version: 1, projects: ["../outside"] },
  { version: 1, projects: ["/absolute"] },
  { version: 1, projects: [""] },
  { version: 1, projects: Array.from({ length: 1001 }, () => "apps/web") },
])("rejects invalid saved data without replacing it: %j", async value => {
  put(".typelatch/scope.json", value)
  const before = readFileSync(path(), "utf8")
  await expect(readScope(root)).rejects.toThrow(/scope/i)
  await expect(updateScope(root, "set", ["apps/web"])).rejects.toThrow(/scope/i)
  expect(readFileSync(path(), "utf8")).toBe(before)
})

it("rejects missing manifests, malformed manifests, outside paths and oversized selections", async () => {
  mkdirSync(join(root, "empty"))
  put("bad/package.json", "bad json")
  for (const project of ["missing", "empty", "bad", ".."]) {
    await expect(updateScope(root, "add", [project])).rejects.toThrow()
    expect(await readScope(root)).toBeNull()
  }
  await expect(updateScope(root, "set", Array.from({ length: 1001 }, () => "apps/web"))).rejects.toThrow(/1000/)
})

it("resolves internal project links canonically but rejects project and manifest symlink escapes", async () => {
  symlinkSync(join(root, "apps/web"), join(root, "web-link"))
  expect((await updateScope(root, "set", ["web-link"])).projects).toEqual([join(root, "apps/web")])
  symlinkSync(dirname(root), join(root, "outside-link"))
  await expect(updateScope(root, "set", ["outside-link"])).rejects.toThrow(/outside|escape/i)
  mkdirSync(join(root, "linked-manifest"))
  symlinkSync(join(root, "package.json"), join(root, "linked-manifest/package.json"))
  await expect(updateScope(root, "set", ["linked-manifest"])).rejects.toThrow(/symlink|regular/i)
})

it("rejects symlinked config directories and files before reading or writing", async () => {
  mkdirSync(join(root, "config"))
  symlinkSync(join(root, "config"), join(root, ".typelatch"))
  await expect(readScope(root)).rejects.toThrow(/symlink/i)
  await expect(updateScope(root, "set", ["apps/web"])).rejects.toThrow(/symlink/i)
  rmSync(join(root, ".typelatch"))
  mkdirSync(join(root, ".typelatch"))
  put("config/scope.json", { version: 1, projects: ["apps/web"] })
  symlinkSync(join(root, "config/scope.json"), path())
  await expect(readScope(root)).rejects.toThrow(/symlink/i)
  await expect(clearScope(root)).rejects.toThrow(/symlink/i)
  expect(JSON.parse(readFileSync(join(root, "config/scope.json"), "utf8"))).toEqual({ version: 1, projects: ["apps/web"] })
})

it("writes sorted root-relative paths including an explicit root package", async () => {
  const scope = await updateScope(root, "set", ["apps/web", ".", "apps/api"])
  expect(scope.projects.map(project => relative(root, project) || ".")).toEqual([".", "apps/api", "apps/web"])
  expect(JSON.parse(readFileSync(path(), "utf8")).projects).toEqual([".", "apps/api", "apps/web"])
})
