import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { getSymbol, queryBrain } from "../src/query.js"

const packageName = "@recovery/fixture"
const version = "1.2.3"

describe.each([{ name: "search", query: queryBrain }, { name: "symbol", query: getSymbol }])("missing library index recovery for $name", ({ query }) => {
  let home: string
  let path: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "typelatch-recovery-"))
    vi.stubEnv("TYPELATCH_HOME", home)
    vi.stubEnv("TYPELATCH_USAGE", "off")
    path = brainPath(packageName, version)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  function seed(selectedVersion: string): void {
    const selectedPath = brainPath(packageName, selectedVersion)
    mkdirSync(dirname(selectedPath), { recursive: true })
    const db = createBrainDatabase(selectedPath, "baseline")
    db.prepare("INSERT INTO metadata VALUES ('format','baseline'),('schemaVersion','1'),('package',?),('version',?),('integrity','sha512-fixture')").run(packageName, selectedVersion)
    db.pragma("journal_mode = DELETE")
    db.close()
  }

  function snapshot(): unknown {
    return readdirSync(home, { recursive: true }).map(String).sort().map(relative => {
      const file = join(home, relative)
      return [relative, statSync(file).isFile() ? readFileSync(file).toString("base64") : null]
    })
  }

  it.each(["absent package", "empty version directory", "different installed version"])("reports the exact recovery command for %s without modifying the cache", state => {
    if (state === "empty version directory") mkdirSync(dirname(path), { recursive: true })
    if (state === "different installed version") seed("2.0.0")
    const before = snapshot()
    expect(() => query(packageName, "api.decode", { version })).toThrow("No brain installed for @recovery/fixture@1.2.3. Run: typelatch add @recovery/fixture@1.2.3")
    expect(snapshot()).toEqual(before)
  })

  it("preserves omitted version recovery when nothing is installed", () => {
    expect(() => query(packageName, "api.decode")).toThrow("No brain installed for @recovery/fixture. Run: typelatch add @recovery/fixture")
    expect(snapshot()).toEqual([])
  })

  it("preserves latest installed version selection when version is omitted", () => {
    seed("1.0.0")
    seed("2.0.0")
    const before = snapshot()
    expect(query(packageName, "api.decode")).toMatchObject({ package: packageName, version: "2.0.0" })
    expect(snapshot()).toEqual(before)
  })

  it("preserves identity validation errors", () => {
    expect(() => query("../escape", "api.decode", { version })).toThrow(/^Invalid npm package name:/)
    expect(() => query(packageName, "api.decode", { version: "^1.2.3" })).toThrow(/^Expected an exact package version, received:/)
    expect(snapshot()).toEqual([])
  })

  it("does not label corrupt bytes as a missing index", () => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "This is not a SQLite index.\n")
    const before = snapshot()
    expect(() => query(packageName, "api.decode", { version })).toThrow(/not a database|malformed/i)
    expect(snapshot()).toEqual(before)
  })

  it.skipIf(process.getuid?.() === 0 || process.platform === "win32").each(["file", "directory"])("preserves a permission error for an inaccessible %s", target => {
    seed(version)
    const before = snapshot()
    const restrictedPath = target === "file" ? path : dirname(path)
    chmodSync(restrictedPath, 0o000)
    try {
      expect(() => query(packageName, "api.decode", { version })).toThrow(/open|access|permission|EACCES|directory/i)
      expect(() => query(packageName, "api.decode", { version })).not.toThrow(/No brain installed|typelatch add/)
    } finally {
      chmodSync(restrictedPath, target === "file" ? 0o600 : 0o700)
    }
    expect(snapshot()).toEqual(before)
  })

  it("preserves an explicit file override and its database errors", () => {
    const override = join(home, "missing.db")
    expect(() => query(packageName, "api.decode", { version, brainFile: override })).toThrow(/open|exist/i)
    expect(() => query(packageName, "api.decode", { version, brainFile: override })).not.toThrow(/No brain installed|typelatch add/)
    expect(snapshot()).toEqual([])
  })
})
