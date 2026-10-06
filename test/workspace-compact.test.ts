import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { workspaceSearch } from "../src/workspace/search.js"

describe("compact workspace discovery", () => {
  let directory: string
  let root: string
  let previousHome: string | undefined
  const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-compact-")))
    root = join(directory, "project")
    mkdirSync(root)
    execFileSync("git", ["init", "-q", root])
    previousHome = process.env.TYPELATCH_HOME
    process.env.TYPELATCH_HOME = join(directory, "cache")
    put(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
    put(join(root, "tsconfig.json"), JSON.stringify({ include: ["src"] }))
    put(join(root, "src/requests.ts"), `export function validateRequest(value: string) {\n  const message = ${JSON.stringify("Validation preserves request identity. 🦊 ".repeat(60))}\n  return value !== message\n}\n`)
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.TYPELATCH_HOME
    else process.env.TYPELATCH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })

  it("preserves source identity, ranking, full coverage and evidence with explicit excerpt omissions", async () => {
    const input = { workspaceRoot: root, question: "validateRequest", scope: "workspace" as const }
    const full = await workspaceSearch(input)
    const compact = await workspaceSearch({ ...input, detail: "compact" })
    expect(compact.coverage).toEqual(full.coverage)
    expect(compact.checks).toEqual(full.checks)
    expect(compact.status).toBe(full.status)
    expect(compact.results).toHaveLength(full.results.length)
    for (const [index, result] of compact.results.entries()) {
      const original = full.results[index]!
      expect(result).toMatchObject({ origin: original.origin, source: original.source, line: original.line, endLine: original.endLine, symbol: original.symbol, position: original.position, score: original.score, matchedTerms: original.matchedTerms, projectRoot: original.projectRoot })
      expect([...result.snippet]).toHaveLength(Math.min(360, [...original.snippet].length))
      expect(original.snippet.startsWith(result.snippet)).toBe(true)
      expect(result.preview).toEqual({ omittedCharacters: [...original.snippet].length - [...result.snippet].length })
      expect(result.signature).toBeUndefined()
    }
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(full)))
  })

  it("preserves exact dependency identity, preparation gaps and executable lookup arguments", async () => {
    put(join(root, "node_modules/codec/package.json"), JSON.stringify({ name: "codec", version: "1.2.3" }))
    put(join(root, "node_modules/missing/package.json"), JSON.stringify({ name: "missing", version: "4.5.6" }))
    const path = brainPath("codec", "1.2.3")
    mkdirSync(dirname(path), { recursive: true })
    const db = createBrainDatabase(path, "baseline")
    db.prepare("INSERT INTO metadata VALUES ('package','codec'),('version','1.2.3'),('integrity','sha512-fixture')").run()
    db.prepare(`INSERT INTO symbols(qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count)
      VALUES ('index.validateRequest','validateRequest','function','index',?,'Validate request','index.d.ts',5,5,'',1,0,0,NULL,0)`).run(`function validateRequest(value: string): ${"string | ".repeat(100)}never`)
    db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (1,'validateRequest','validate request','public')").run()
    db.close()
    const input = { workspaceRoot: root, question: "validateRequest", scope: "dependencies" as const }
    const full = await workspaceSearch(input)
    const compact = await workspaceSearch({ ...input, detail: "compact" })
    expect(compact.coverage).toEqual(full.coverage)
    expect(compact.checks).toEqual(full.checks)
    expect(compact.status).toBe("partial")
    expect(compact.coverage.missingIndexes).toBe(1)
    expect(compact.results[0]).toMatchObject({ package: "codec", version: "1.2.3", integrity: "sha512-fixture", source: "index.d.ts", line: 5,
      inspect: { tool: "library_symbol", arguments: { package: "codec", version: "1.2.3", symbol: "index.validateRequest" } } })
  })

  it("keeps empty and partial states distinct in compact mode", async () => {
    const empty = await workspaceSearch({ workspaceRoot: root, question: "doesNotExist", scope: "workspace", detail: "compact" })
    expect(empty.status).toBe("empty")
    expect(empty.results).toEqual([])
    put(join(root, "node_modules/missing/package.json"), JSON.stringify({ name: "missing", version: "4.5.6" }))
    const partial = await workspaceSearch({ workspaceRoot: root, question: "doesNotExist", detail: "compact" })
    expect(partial.status).toBe("partial")
    expect(partial.results).toEqual([])
    expect(partial.coverage.missingIndexes).toBe(1)
  })

  it("accepts the CLI compact flag before the question and labels omitted text", () => {
    const args = [join(process.cwd(), "dist/cli.js"), "search", "--compact", "validateRequest", "--root", root, "--scope", "workspace"]
    const result = JSON.parse(execFileSync(process.execPath, [...args, "--json"], { encoding: "utf8" }))
    expect(result).toMatchObject({ detail: "compact", question: "validateRequest", status: "ok" })
    expect(result.results[0].preview.omittedCharacters).toBeGreaterThan(0)
    expect(execFileSync(process.execPath, args, { encoding: "utf8" })).toMatch(/\[\d+ characters omitted\]/)
  })
})
