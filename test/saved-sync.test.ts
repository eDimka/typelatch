import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, expect, it } from "vitest"
import { planSync } from "../src/sync.js"

let root: string
const put = (path: string, value: unknown) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const project = (path: string, version: string) => {
  put(`${path}/package.json`, { dependencies: { effect: version } })
  put(`${path}/package-lock.json`, { lockfileVersion: 3, packages: { "node_modules/effect": { version } } })
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-saved-sync-")))
  mkdirSync(join(root, ".git"))
  project(".", "1.0.0")
  project("apps/web", "2.0.0")
  project("apps/api", "3.0.0")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("uses saved projects from root and descendants, retaining additive selections", async () => {
  put(".typelatch/scope.json", { version: 1, projects: ["apps/web"] })
  const first = await planSync({ cwd: root })
  expect(first.targets.map(item => item.version)).toEqual(["2.0.0"])
  put(".typelatch/scope.json", { version: 1, projects: ["apps/web", "apps/api"] })
  const next = await planSync({ cwd: join(root, "apps/web") })
  expect(next.targets.map(item => item.version)).toEqual(["2.0.0", "3.0.0"])
})

it("lets explicit project/workspace flags override the saved defaults without changing them", async () => {
  put("package.json", { workspaces: ["apps/*"] })
  put(".typelatch/scope.json", { version: 1, projects: ["apps/web"] })
  const before = readFileSync(join(root, ".typelatch/scope.json"), "utf8")
  const explicit = await planSync({ cwd: root, projects: ["apps/api"] })
  expect(explicit.targets.map(item => item.version)).toEqual(["3.0.0"])
  const expanded = await planSync({ cwd: root, workspaces: true })
  expect(expanded.targets.map(item => item.version)).toEqual(["2.0.0", "3.0.0"])
  expect(readFileSync(join(root, ".typelatch/scope.json"), "utf8")).toBe(before)
})

it("preserves an empty saved subset and fails visibly for invalid or stale configuration", async () => {
  put(".typelatch/scope.json", { version: 1, projects: [] })
  const empty = await planSync({ cwd: root })
  expect(empty.ready).toBe(true)
  expect(empty.projects).toEqual([])
  expect(empty.targets).toEqual([])
  put(".typelatch/scope.json", "{broken")
  expect((await planSync({ cwd: root })).ready).toBe(false)
  put(".typelatch/scope.json", { version: 1, projects: ["deleted/project"] })
  const stale = await planSync({ cwd: root })
  expect(stale.ready).toBe(false)
  expect(stale.targets).toEqual([])
})
