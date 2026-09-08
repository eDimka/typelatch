import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import Database from "better-sqlite3"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { workspaceContext } from "../src/workspace/context.js"
import { validateSupportManifest } from "../src/support.js"

it("keeps the pinned corpus while supporting two exact versions of Effect", () => {
  const manifest = validateSupportManifest(JSON.parse(readFileSync("examples/support/manifest.json", "utf8")))
  const effects = manifest.packages.filter(p => p.name === "effect")
  expect(effects.map(p => p.version.split(".")[0])).toEqual(["3", "4"])
  expect(new Set(effects.map(p => p.importSpecifier)).size).toBe(2)
  const duplicate = structuredClone(manifest)
  duplicate.packages.push(structuredClone(effects[0]!))
  expect(() => validateSupportManifest(duplicate)).toThrow("Duplicate support package version")
  const missing = structuredClone(manifest)
  missing.packages.shift()
  expect(() => validateSupportManifest(missing)).toThrow("Corpus identity mismatch")
  const tampered = structuredClone(manifest)
  tampered.packages[0]!.integrity = "wrong-integrity"
  expect(() => validateSupportManifest(tampered)).toThrow("Corpus identity mismatch")
  const duplicateTask = structuredClone(manifest)
  duplicateTask.packages.at(-1)!.tasks[0]!.id = duplicateTask.packages[0]!.tasks[0]!.id
  expect(() => validateSupportManifest(duplicateTask)).toThrow("Duplicate support task IDs")
})

const roots: string[] = []
const previousHome = process.env.APIROVA_HOME
afterEach(() => {
  if (previousHome === undefined) delete process.env.APIROVA_HOME
  else process.env.APIROVA_HOME = previousHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "apirova-support-test-")))
  roots.push(root)
  process.env.APIROVA_HOME = join(root, "brains")
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  write("package.json", '{"type":"module"}')
  write("tsconfig.json", '{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true,"types":[]},"files":["main.ts"]}')
  write("main.ts", 'import convert, { tools } from "widget"; export const output = convert(tools.convert(42));')
  write("node_modules/widget/package.json", '{"name":"widget","version":"1.0.0","type":"module","types":"index.d.ts"}')
  write("node_modules/widget/index.d.ts", 'export default function convert(value: string): number; export declare namespace tools { function convert(value: number): string; }')
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  const path = brainPath("widget", "1.0.0")
  mkdirSync(dirname(path), { recursive: true })
  const db = createBrainDatabase(path, "baseline")
  db.prepare("INSERT INTO metadata(key,value) VALUES ('package','widget'),('version','1.0.0'),('integrity','fixture-only')").run()
  const insert = db.prepare("INSERT INTO symbols(qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count) VALUES (?,?,'function','entry','fixture signature','conversion fixture','index.d.ts',1,1,'',1,0,0,NULL,0)")
  for (const [index, name] of ["default", "tools.convert", "private.convert", "convert", "privateOnly"].entries()) {
    insert.run(`entry.${name}`, name)
    db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (?,?,'conversion fixture','public')").run(index + 1, name)
  }
  db.close()
  return { root, path, write, request: { config: join(root, "tsconfig.json"), file: "main.ts", importSpecifier: "widget", expectedVersion: "1.0.0", question: "conversion fixture", limit: 10 } }
}

it("joins module-prefixed default and nested exports without flattening private namespaces", () => {
  const { request } = fixture()
  const live = workspaceContext({ ...request, symbol: "default" })
  const bySymbol = new Map(live.candidates.map(candidate => [candidate.symbol, candidate]))
  expect(bySymbol.get("entry.default")?.workspaceExport?.signatures).toEqual(["(value: string): number"])
  expect(bySymbol.get("entry.tools.convert")?.workspaceExport?.signatures).toEqual(["(value: number): string"])
  expect(bySymbol.get("entry.convert")?.workspaceExport?.signatures).toEqual(["(value: string): number"])
  expect(bySymbol.get("entry.private.convert")?.workspaceExport).toBeNull()
  expect(bySymbol.get("entry.privateOnly")?.workspaceExport).toBeNull()
  expect(live.api?.name).toBe("default")
  expect(workspaceContext({ ...request, symbol: "convert" }).api).toBeNull()
  expect(workspaceContext({ ...request, symbol: "arbitraryPrivateName" }).api).toBeNull()
  expect(live.candidates.every(candidate => !candidate.artifactEquivalent)).toBe(true)
  expect(live.checks.artifactMatch.status).toBe("unknown")
  expect(live.checks.typechecked.status).toBe("not-run")
})

it("blocks discovery for mismatched brain metadata even when a matching database path exists", () => {
  const { request, path } = fixture()
  const db = new Database(path)
  db.prepare("UPDATE metadata SET value = '2.0.0' WHERE key = 'version'").run()
  db.close()
  const live = workspaceContext(request)
  expect(live.checks.versionMatch.status).toBe("pass")
  expect(live.checks.retrieved.status).toBe("fail")
  expect(live.brain).toBeNull()
  expect(live.candidates).toEqual([])
})

it("refreshes an overlaid declaration and then returns to disk without stale types", () => {
  const { request, root } = fixture()
  const disk = workspaceContext({ ...request, symbol: "default" })
  const overlaid = workspaceContext({ ...request, symbol: "default", overlays: [{ file: join(root, "node_modules/widget/index.d.ts"), text: 'export default function convert(value: boolean): bigint; export declare const tools: any;' }] })
  const refreshed = workspaceContext({ ...request, symbol: "default" })
  expect(disk.api?.signatures).toEqual(["(value: string): number"])
  expect(overlaid.api?.signatures).toEqual(["(value: boolean): bigint"])
  expect(refreshed.api?.signatures).toEqual(disk.api?.signatures)
  expect(overlaid.snapshot.id).not.toBe(disk.snapshot.id)
  expect(refreshed.snapshot.id).toBe(disk.snapshot.id)
})


it("uses live cursor identity for navigation without a question or supplied expected symbol", () => {
  const { request, write, path } = fixture()
  const source = 'import renamed from "widget"; const local = () => 1; export const output = renamed("hello"); local();'
  write("main.ts", source)
  const input = { config: request.config, file: request.file, importSpecifier: "widget", expectedVersion: "1.0.0", position: source.indexOf('renamed("hello")') + 1 }
  const result = workspaceContext(input)
  expect(result.brain).toBeNull()
  expect(result.navigation.status).toBe("pass")
  expect(result.navigation.exportName).toBe("default")
  expect(result.navigation.brain?.results.map(r => r.symbol)).toContain("entry.convert")
  expect(result.navigation.artifactEquivalent).toBe(false)
  expect(workspaceContext({ ...input, expectedVersion: "2.0.0" }).navigation.status).toBe("not-run")
  expect(workspaceContext({ ...input, position: source.lastIndexOf("local()") + 1 }).navigation.status).toBe("unknown")
  const db = new Database(path)
  db.prepare("UPDATE metadata SET value = 'other' WHERE key = 'package'").run()
  db.close()
  expect(workspaceContext(input).navigation.status).toBe("fail")
})
