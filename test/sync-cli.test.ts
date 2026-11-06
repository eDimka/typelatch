import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { c } from "tar"

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

it("continues past a package without TypeScript evidence and reports incomplete preparation", () => {
  const registry: Record<string, { archive: string; integrity: string }> = {}
  for (const name of ["a-native", "z-typed"]) {
    put(`fixtures/${name}/package/package.json`, { name, version: "1.0.0" })
    put(`fixtures/${name}/package/${name === "a-native" ? "index.js" : "index.d.ts"}`, name === "a-native" ? "exports.value = 42" : "export declare const value: number")
    const archive = join(root, `fixtures/${name}.tgz`)
    c({ cwd: join(root, `fixtures/${name}`), file: archive, sync: true, gzip: true }, ["package"])
    registry[`${name}@1.0.0`] = { archive, integrity: `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}` }
  }
  put("package.json", { dependencies: { "a-native": "1.0.0", "z-typed": "1.0.0" } })
  put("package-lock.json", { lockfileVersion: 3, packages: Object.fromEntries(Object.entries(registry).map(([spec, value]) => [`node_modules/${spec.split("@")[0]}`, { version: "1.0.0", integrity: value.integrity }])) })
  writeFileSync(join(root, "bin/npm"), `#!${process.execPath}\nconst fs = require("node:fs"), path = require("node:path");
const registry = ${JSON.stringify(registry)};
const [command, spec, ...args] = process.argv.slice(2), item = registry[spec];
if (!item) process.exit(89);
if (command === "view") console.log(JSON.stringify({name:spec.split("@")[0], version:"1.0.0", "dist.integrity":item.integrity, "dist.tarball":"https://example.invalid/fixture.tgz"}));
else if (command === "pack") { const filename = path.basename(item.archive); fs.copyFileSync(item.archive,path.join(args[args.indexOf("--pack-destination")+1],filename)); console.log(JSON.stringify([{filename,size:fs.statSync(item.archive).size,unpackedSize:200}])); }
else process.exit(89);\n`, { mode: 0o755 })
  const result = run("--json")
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report).toMatchObject({ success: true, complete: false })
  expect(report.results).toMatchObject([
    { name: "a-native", version: "1.0.0", status: "unsupported", reason: expect.stringContaining("neither TypeScript source nor declaration files") },
    { name: "z-typed", version: "1.0.0", status: "indexed" }
  ])
  expect(existsSync(join(root, "data/brains/a-native/1.0.0/brain.db"))).toBe(false)
  expect(existsSync(join(root, "data/brains/z-typed/1.0.0/brain.db"))).toBe(true)
})

it("still fails on registry errors rather than classifying them as unsupported", () => {
  const result = run("--json")
  expect(result.status).toBe(1)
  const report = JSON.parse(result.stdout)
  expect(report).toMatchObject({ success: false, complete: false, results: [{ name: "effect", status: "error" }] })
})

it.each([["--project"], ["--project", "--json"], ["--projct", "apps/web"], ["--lockfile"], ["--lockfile", "a", "--lockfile", "b"]])("rejects malformed options %j before execution", (...args) => {
  const result = run(...args)
  expect(result.status).toBe(1)
  expect(existsSync(join(root, "npm-called"))).toBe(false)
})
