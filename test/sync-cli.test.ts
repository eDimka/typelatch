import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"

let root: string
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const tsx = import.meta.resolve("tsx")
function put(path: string, value: unknown) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
}
function project(path: string, version: string) {
  put(`${path}/package.json`, { dependencies: { effect: `^${version}` } })
  put(`${path}/package-lock.json`, { lockfileVersion: 3, packages: { "node_modules/effect": { version } } })
}
function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsx, cli, "sync", ...args], {
    cwd: root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, TYPELATCH_HOME: join(root, "data"), PATH: `${join(root, "bin")}:${process.env.PATH}`, SYNC_NPM_MARKER: join(root, "npm-called") },
  })
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-sync-cli-")))
  mkdirSync(join(root, ".git"))
  project(".", "1.0.0")
  mkdirSync(join(root, "bin"))
  writeFileSync(join(root, "bin/npm"), '#!/bin/sh\nprintf called > "$SYNC_NPM_MARKER"\nexit 89\n', { mode: 0o755 })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("previews repeated project selections without executing npm or creating indexes", () => {
  project("apps/web", "3.22.1")
  project("services/api", "4.0.0")
  const result = run("--project", "apps/web", "--project", "services/api", "--dry-run", "--json")
  expect(result.status, result.stderr).toBe(0)
  const plan = JSON.parse(result.stdout)
  expect(plan.ready).toBe(true)
  expect(plan.projects.map((item: any) => item.root).sort()).toEqual([join(root, "apps/web"), join(root, "services/api")])
  expect(plan.targets.map((item: any) => item.version).sort()).toEqual(["3.22.1", "4.0.0"])
  expect(plan.targets.every((item: any) => item.cache === "missing")).toBe(true)
  expect(existsSync(join(root, "npm-called"))).toBe(false)
  expect(existsSync(join(root, "data"))).toBe(false)
})

it("expands only declared workspaces and preserves the default current package scope", () => {
  put("package.json", { workspaces: ["apps/*", "!apps/old"], dependencies: { effect: "^1.0.0" } })
  project("apps/web", "3.22.1")
  project("apps/old", "2.0.0")
  project("examples/demo", "5.0.0")
  const expanded = run("--workspaces", "--dry-run", "--json")
  expect(expanded.status, expanded.stderr).toBe(0)
  expect(JSON.parse(expanded.stdout).targets.map((item: any) => item.version).sort()).toEqual(["1.0.0", "3.22.1"])
  const current = run("--dry-run", "--json")
  expect(current.status, current.stderr).toBe(0)
  expect(JSON.parse(current.stdout).targets.map((item: any) => item.version)).toEqual(["1.0.0"])
})

it("reports an invalid complete plan before performing any download", () => {
  project("apps/web", "3.22.1")
  project("apps/api", "4.0.0")
  put("apps/api/bun.lock", { lockfileVersion: 1, packages: {} })
  const result = run("--project", "apps/web", "--project", "apps/api", "--json")
  expect(result.status).toBe(1)
  const plan = JSON.parse(result.stdout)
  expect(plan.ready).toBe(false)
  expect(plan.issues.join(" ")).toContain("Ambiguous lockfiles")
  expect(existsSync(join(root, "npm-called"))).toBe(false)
})

it("accepts an explicit lockfile choice and shows its provenance", () => {
  put("bun.lock", { lockfileVersion: 1, packages: { effect: ["effect@3.22.1", "", {}] } })
  const result = run("--lockfile", "bun.lock", "--dry-run", "--json")
  expect(result.status, result.stderr).toBe(0)
  const plan = JSON.parse(result.stdout)
  expect(plan.targets[0].version).toBe("3.22.1")
  expect(plan.projects[0].lockfile).toBe(join(root, "bun.lock"))
})

it("skips a verified cached index when executing the plan", () => {
  const path = join(root, "data/brains/effect/1.0.0/brain.db")
  mkdirSync(dirname(path), { recursive: true })
  const db = createBrainDatabase(path, "baseline")
  for (const [key, value] of Object.entries({ package: "effect", version: "1.0.0", integrity: "sha512-cached" })) db.prepare("INSERT INTO metadata VALUES (?, ?)").run(key, value)
  db.close()
  const result = run("--json")
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.targets[0].cache).toBe("ready")
  expect(report.results[0].status).toBe("cached")
  expect(existsSync(join(root, "npm-called"))).toBe(false)
})

it.each([["--project"], ["--project", "--json"], ["--projct", "apps/web"], ["--lockfile"], ["--lockfile", "a", "--lockfile", "b"]])("rejects malformed options %j before execution", (...args) => {
  const result = run(...args)
  expect(result.status).toBe(1)
  expect(existsSync(join(root, "npm-called"))).toBe(false)
})
