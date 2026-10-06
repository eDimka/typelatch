import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"

let root: string
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const put = (path: string, value: unknown) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
const project = (path: string, version: string) => {
  put(`${path}/package.json`, { dependencies: { effect: version } })
  put(`${path}/package-lock.json`, { lockfileVersion: 3, packages: { "node_modules/effect": { version } } })
}
const run = (...args: string[]) => spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
  cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, TYPELATCH_HOME: join(root, "data") },
})
const json = (...args: string[]) => {
  const result = run(...args, "--json")
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-scope-cli-")))
  mkdirSync(join(root, ".git"))
  project(".", "1.0.0")
  project("apps/web", "2.0.0")
  project("apps/api", "3.0.0")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("saves a subset, expands it later and preserves an explicit empty selection", () => {
  expect(json("scope", "list").configured).toBe(false)
  json("scope", "add", "apps/web")
  expect(json("sync", "--dry-run").targets.map((item: any) => item.version)).toEqual(["2.0.0"])
  json("scope", "add", "apps/api")
  expect(json("scope", "list").projects).toEqual([join(root, "apps/api"), join(root, "apps/web")])
  expect(json("sync", "--dry-run").targets.map((item: any) => item.version)).toEqual(["2.0.0", "3.0.0"])
  json("scope", "remove", "apps/web", "apps/api")
  expect(json("sync", "--dry-run").targets).toEqual([])
  expect(existsSync(join(root, "data"))).toBe(false)
}, 20_000)

it("sets a replacement subset and clears the saved selection explicitly", () => {
  json("scope", "add", "apps/web")
  json("scope", "set", "apps/api")
  expect(json("scope", "list").projects).toEqual([join(root, "apps/api")])
  json("scope", "clear")
  expect(json("scope", "list").configured).toBe(false)
  expect(json("sync", "--dry-run").targets.map((item: any) => item.version)).toEqual(["1.0.0"])
}, 20_000)

it.each([["add"], ["remove"], ["set"], ["list", "apps/web"], ["clear", "apps/web"], ["add", "--unknown"], ["unknown"]])("rejects invalid scope command %j without creating saved state", (...args) => {
  const result = run("scope", ...args)
  expect(result.status).toBe(1)
  expect(existsSync(join(root, ".typelatch/scope.json"))).toBe(false)
})
