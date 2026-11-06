import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"

let directory: string
let root: string
let home: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-cli-loading-")))
  root = join(directory, "repo")
  home = join(directory, "data")
  mkdirSync(join(root, ".git"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "cli-fixture", private: true }))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function run(args: string[]) {
  const report = join(directory, "loaded.json")
  const cli = join(process.cwd(), "dist/cli.js")
  const script = `
    import { createRequire } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const require = createRequire(import.meta.url);
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];
    process.on('exit', () => writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.keys(require.cache))));
    await import(${JSON.stringify(pathToFileURL(cli).href)});
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, TYPELATCH_HOME: home, TYPELATCH_USAGE: "off" },
  })
  expect(result.error).toBeUndefined()
  const modules = JSON.parse(readFileSync(report, "utf8")) as string[]
  return { ...result, modules }
}

function expectNoCompiler(modules: string[]): void {
  expect(modules.filter(path => path.endsWith("/typescript/lib/typescript.js"))).toEqual([])
}

function expectNoDatabase(modules: string[]): void {
  expect(modules.filter(path => path.includes("/better-sqlite3/"))).toEqual([])
}

it.each([[], ["--help"], ["-h"], ["setup", "--help"]])("shows help without loading compiler or database modules for %j", (...args) => {
  const result = run(args)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain("typelatch")
  expectNoCompiler(result.modules)
  expectNoDatabase(result.modules)
  expect(existsSync(home)).toBe(false)
})

it.each([["unknown-command"], ["add"], ["query"], ["symbol"], ["workspace"], ["validate"], ["search"]])("reports argument errors before loading command dependencies for %j", (...args) => {
  const result = run(args)
  expect(result.status).toBe(1)
  expect(result.stderr).toMatch(/^typelatch: (?:Usage:|Unknown command:)/)
  expectNoCompiler(result.modules)
  expectNoDatabase(result.modules)
  expect(existsSync(home)).toBe(false)
})

it("reads saved scope without loading a compiler or package database", () => {
  const result = run(["scope", "list", "--json"])
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ configured: false })
  expectNoCompiler(result.modules)
  expectNoDatabase(result.modules)
  expect(existsSync(home)).toBe(false)
})

it("plans synchronization without loading the package compiler", () => {
  const result = run(["sync", "--dry-run", "--json"])
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ready: true, targets: [] })
  expectNoCompiler(result.modules)
  expect(existsSync(home)).toBe(false)
})

it.each(["query", "symbol"])("reads a local index through %s without loading the compiler", command => {
  const target = join(home, "brains", "fixture-codec", "1.2.3")
  mkdirSync(target, { recursive: true })
  const db = createBrainDatabase(join(target, "brain.db"), "baseline")
  db.prepare("INSERT INTO metadata VALUES ('format','baseline'),('schemaVersion','1'),('package','fixture-codec'),('version','1.2.3'),('integrity','sha512-fixture')").run()
  db.prepare("INSERT INTO symbols (qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count) VALUES ('api.decode','decode','function','api','decode(value: string): string','Decode a packet.','api.d.ts',1,1,'',1,0,0,NULL,0)").run()
  db.close()
  const result = run([command, "fixture-codec@1.2.3", "api.decode", "--json"])
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ package: "fixture-codec", version: "1.2.3", results: [{ symbol: "api.decode" }] })
  expectNoCompiler(result.modules)
})

it.each(["query", "symbol"])("preserves the CLI error boundary for a missing %s index", command => {
  const result = run([command, "fixture-codec@1.2.3", "api.decode", "--json"])
  expect(result.status).toBe(1)
  expect(result.stderr.trim()).toBe("typelatch: No brain installed for fixture-codec@1.2.3. Run: typelatch add fixture-codec@1.2.3")
  expect(result.stdout).toBe("")
  expectNoCompiler(result.modules)
  expect(existsSync(home)).toBe(false)
})
