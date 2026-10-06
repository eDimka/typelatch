import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { hash, type WorkspaceFile } from "../src/workspace/inventory.js"
import { searchWorkspaceIndex } from "../src/workspace/search-index.js"

describe("workspace cache storage", () => {
  let directory: string
  let root: string
  const previousHome = process.env.TYPELATCH_HOME
  const file = (name: string, text: string): WorkspaceFile => ({ path: join(root, name), text, hash: hash(text), searchable: true })
  const search = (files: WorkspaceFile[], question: string) => searchWorkspaceIndex(root, files, question, new AbortController().signal)

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "typelatch-storage-"))
    root = join(directory, "workspace")
    process.env.TYPELATCH_HOME = join(directory, "data")
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.TYPELATCH_HOME
    else process.env.TYPELATCH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })

  it("bounds persistent bytes while retaining raw snippets and exact locations", () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`src/service${i}.ts`, Array.from({ length: 40 }, (_, j) =>
      `/** Validate incoming request ${j} and preserve its payload before dispatch. */\nexport function validateRequest${i}_${j}(payload: string): string {\n  return payload.trim()\n}\n`).join("\n")))
    const before = search(files, "validateRequest12_23")
    expect(before.candidates.some(candidate => candidate.symbol === "validateRequest12_23" && candidate.position === files[12]!.text.indexOf("validateRequest12_23"))).toBe(true)
    expect(search(files, "validateRequest12_23").candidates).toEqual(before.candidates)
    expect(search(files, "validateRequest12_23").index.updatedFiles).toBe(0)
    const sourceBytes = files.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0)
    // Storing overlapping excerpts costs over six times the source bytes here.
    expect(statSync(before.index.path).size).toBeLessThan(sourceBytes * 4)
  })

  it("reconstructs long Unicode excerpts and CRLF locations exactly from the current inventory", () => {
    const text = `// heading\r\nexport const unicodeSignal = "${"a🦊".repeat(1700)}";\r\n// tailquartz\r\n`
    const input = [file("unicode.ts", text)]
    const first = search(input, "unicodeSignal")
    const declaration = first.candidates.find(candidate => candidate.symbol === "unicodeSignal")!
    expect(declaration).toMatchObject({ line: 2, endLine: 2, position: text.indexOf("unicodeSignal"), snippet: text.slice(text.indexOf("export"), text.indexOf("export") + 2400) })
    const tail = search(input, "tailquartz")
    expect(tail.candidates.length).toBeGreaterThan(0)
    for (const candidate of tail.candidates) {
      expect(text.includes(candidate.snippet)).toBe(true)
      expect(candidate.endLine).toBe(candidate.line + (candidate.snippet.match(/\n/g)?.length ?? 0))
    }
    expect(search(input, "unicodeSignal").candidates).toEqual(first.candidates)
    const updated = [file("unicode.ts", text.replaceAll("a🦊", "b🐻"))]
    expect(search(updated, "unicodeSignal").candidates.find(candidate => candidate.symbol === "unicodeSignal")?.snippet).toBe(declaration.snippet.replaceAll("a🦊", "b🐻"))
  })

  it.each([4, 5])("rebuilds a version %s cache and reclaims the obsolete content pages", version => {
    const path = join(process.env.TYPELATCH_HOME!, "workspaces", hash(root), "search.db")
    mkdirSync(dirname(path), { recursive: true })
    const db = new Database(path)
    if (version === 4) {
      db.exec(`CREATE TABLE files(path TEXT PRIMARY KEY, hash TEXT NOT NULL, truncated INTEGER NOT NULL);
        CREATE VIRTUAL TABLE chunks USING fts5(source UNINDEXED, line UNINDEXED, endLine UNINDEXED, symbol, position UNINDEXED, snippet, terms, tokenize='porter unicode61')`)
      db.prepare("INSERT INTO files VALUES (?,'old-hash',0)").run(join(root, "deleted.ts"))
      db.prepare("INSERT INTO chunks VALUES (?,1,1,'legacyobsolete',0,?,'legacy obsolete')").run(join(root, "deleted.ts"), "obsolete ".repeat(100_000))
    } else {
      db.exec(`CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, truncated INTEGER NOT NULL);
        CREATE TABLE chunk_content(id INTEGER PRIMARY KEY, file_id INTEGER, line INTEGER, endLine INTEGER, symbol TEXT, position INTEGER, snippet TEXT);
        CREATE VIRTUAL TABLE chunks USING fts5(symbol, snippet, terms, content='', contentless_delete=1, tokenize='porter unicode61')`)
      db.prepare("INSERT INTO files VALUES (1,?,'old-hash',0)").run(join(root, "deleted.ts"))
      db.prepare("INSERT INTO chunk_content VALUES (1,1,1,1,'legacyobsolete',0,?)").run("obsolete ".repeat(100_000))
      db.prepare("INSERT INTO chunks(rowid,symbol,snippet,terms) VALUES (1,'legacyobsolete',?,'legacy obsolete')").run("obsolete ".repeat(100_000))
    }
    db.pragma(`user_version = ${version}`)
    db.close()
    const oldBytes = statSync(path).size
    const files = [file("current.ts", "export const freshMarker = true\n")]
    const refreshed = search(files, "freshMarker")
    expect(refreshed.index.updatedFiles).toBe(1)
    expect(refreshed.candidates.some(candidate => candidate.symbol === "freshMarker")).toBe(true)
    expect(search(files, "legacyobsolete").candidates).toHaveLength(0)
    expect(statSync(path).size).toBeLessThan(oldBytes / 4)
  })

  it("removes stale terms after updates and deletions, including reused file IDs", () => {
    const first = [file("first.ts", "export const priorquartz = 1\n")]
    expect(search(first, "priorquartz").candidates.length).toBeGreaterThan(0)
    const changed = [file("first.ts", "export const freshonyx = 1\n")]
    expect(search(changed, "priorquartz").candidates).toHaveLength(0)
    expect(search(changed, "freshonyx").candidates.length).toBeGreaterThan(0)
    expect(search([], "freshonyx").candidates).toHaveLength(0)
    const reused = [file("second.ts", "export const finaljasper = 1\n")]
    expect(search(reused, "freshonyx").candidates).toHaveLength(0)
    expect(search(reused, "finaljasper").candidates.every(candidate => candidate.source === reused[0]!.path)).toBe(true)
  })
})
