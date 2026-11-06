import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { getSymbol, queryBrain } from "../src/query.js"
import type { BrainFormat } from "../src/types.js"

const named = ["Schema.Trim", "Schema.filter", "Schema.NonEmptyArray", "Schema.Struct"]
const nativeQuestion = `${named.join(" ")} trim transformation before nonempty filter; Struct strips excess properties by default and creates new objects decoding`

describe.each<BrainFormat>(["baseline", "compact", "trimmed"])("explicit qualified references in %s storage", format => {
  const root = mkdtempSync(join(tmpdir(), "typelatch-explicit-names-"))
  const brainFile = join(root, "brain.db")
  const options = { version: "1.2.3", brainFile, recordUsage: false }
  const search = (question: string, limit = 4) => queryBrain("fixture", question, { ...options, limit })

  beforeAll(() => {
    const db = createBrainDatabase(brainFile, format)
    db.prepare("INSERT INTO metadata VALUES ('format',?),('schemaVersion',?)").run(format, String(["baseline", "compact", "trimmed"].indexOf(format) + 1))
    const entries = [
      ...named.map(symbol => ({ symbol, docs: "Declared API.", kind: "const" })),
      { symbol: "Schema.trim", docs: "Trim whitespace and decode values.", kind: "function" },
      { symbol: "Other.Trim", docs: "Trim whitespace and decode values.", kind: "function" },
      { symbol: "api.json", docs: "Serialize a value.", kind: "function" },
      ...Array.from({ length: 70 }, (_, index) => ({ symbol: `Batch.Symbol${index}`, docs: "Batch operation.", kind: "const" })),
      ...Array.from({ length: 100 }, (_, index) => ({ symbol: `Distractor.Behavior${index}`, docs: nativeQuestion, kind: "function" }))
    ]
    for (const [index, entry] of entries.entries()) {
      const id = index + 1
      const name = entry.symbol.slice(entry.symbol.lastIndexOf(".") + 1)
      const module = entry.symbol.slice(0, entry.symbol.lastIndexOf("."))
      if (format !== "baseline") db.prepare("INSERT INTO nodes VALUES (?,?)").run(id, entry.symbol)
      const identityColumn = format === "trimmed" ? "" : "qualified_name,"
      const sourceColumn = format === "trimmed" ? "" : "source,"
      const signature = `export const ${name}: (value: string) => string`
      const values = [id, ...(format === "trimmed" ? [] : [entry.symbol]), name, entry.kind, module,
        signature, entry.docs, `${module}.ts`, 10, 11,
        ...(format === "trimmed" ? [] : [""]), 1, 0, 0, null, 0]
      db.prepare(`INSERT INTO symbols(id,${identityColumn}name,kind,module,signature,docs,source_path,line_start,line_end,${sourceColumn}is_public,is_deprecated,is_internal,category,example_count) VALUES (${values.map(() => "?").join(",")})`).run(...values)
      db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (?,?,?,'public')").run(id, entry.symbol, `${entry.docs}\n${signature}`)
    }
    db.close()
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it.each([
    ["plain", nativeQuestion],
    ["backticked", `Compare ${named.map(symbol => `\`${symbol}\``).join(", ")} for decoding.`],
    ["quoted", `Compare '${named[0]}' and "${named[1]}" and '${named[2]}' and "${named[3]}" for decoding.`]
  ])("returns every exact named identity before lexical distractors when %s", (_style, question) => {
    for (const symbol of named) expect(getSymbol("fixture", symbol, options).results[0]?.symbol).toBe(symbol)
    const result = search(question)
    expect(result.results.map(item => item.symbol)).toEqual(named)
    expect(result).toMatchObject({ requestedSymbols: named.map(symbol => ({ symbol, status: "exact" })) })
    expect(result.strategy).toBe("hybrid")
  })

  it("deduplicates repeated names while preserving first mention order", () => {
    const result = search(`Compare Schema.Struct, Schema.Trim, Schema.Struct, Schema.filter and Schema.NonEmptyArray.`)
    const expected = ["Schema.Struct", "Schema.Trim", "Schema.filter", "Schema.NonEmptyArray"]
    expect(result.results.map(item => item.symbol)).toEqual(expected)
    expect(result).toMatchObject({ requestedSymbols: expected.map(symbol => ({ symbol, status: "exact" })) })
  })

  it("exposes existing names omitted by the result limit", () => {
    const result = search(nativeQuestion, 2)
    expect(result.results.map(item => item.symbol)).toEqual(named.slice(0, 2))
    expect(result).toMatchObject({ requestedSymbols: named.map((symbol, index) => ({ symbol, status: index < 2 ? "exact" : "omitted" })) })
  })

  it("keeps missing names, case mismatches and unresolved aliases explicit", () => {
    const requested = ["Schema.Trim", "Schema.Missing", "schema.Trim", "S.Trim", "Schema.trim"]
    const result = search(`Compare ${requested.join(", ")} for decoding.`)
    expect(result.results.slice(0, 2).map(item => item.symbol)).toEqual(["Schema.Trim", "Schema.trim"])
    expect(result).toMatchObject({ requestedSymbols: requested.map(symbol => ({ symbol, status: symbol === "Schema.Trim" || symbol === "Schema.trim" ? "exact" : "not-found" })) })
    expect(new Set(result.results.map(item => item.symbol)).size).toBe(result.results.length)
  })

  it("does not reinterpret URL, email, filesystem or common filename substrings as requested identities", () => {
    for (const question of [
      "Decode https://example.com/Schema.Trim?q=Schema.filter",
      "Decode user@Schema.Trim",
      "Decode /tmp/Schema.Trim and ./Schema.filter and ../Schema.Struct",
      "Decode C:\\work\\Schema.Trim",
      "Decode package.json and `src/Schema.ts` and tsconfig.json and v3.22.1"
    ]) {
      const result = search(question)
      expect(result).not.toHaveProperty("requestedSymbols")
    }
    expect(getSymbol("fixture", "api.json", options).results.map(item => item.symbol)).toEqual(["api.json"])
  })

  it("leaves ordinary natural queries on the lexical path", () => {
    const result = search("Serialize a value")
    expect(result.results[0]?.symbol).toBe("api.json")
    expect(result.strategy).toBe("hybrid")
    expect(result).not.toHaveProperty("requestedSymbols")
  })

  it("preserves singular discovery and ignores common prose abbreviations", () => {
    const single = search("Schema.Trim", 10)
    expect(single.results.map(item => item.symbol)).toEqual(["Schema.Trim", "Other.Trim", "Schema.trim"])
    expect(single.strategy).toBe("exact")
    expect(single).not.toHaveProperty("requestedSymbols")
    for (const question of ["Compare Schema.Trim Schema.Trim", "Decode, e.g., Schema.Trim; i.e., trim a value", "Use e.g. and i.e. in prose"]) {
      expect(search(question)).not.toHaveProperty("requestedSymbols")
    }
    const compound = search("Compare e.g. Schema.Trim and i.e. Schema.filter", 2)
    expect(compound.results.map(item => item.symbol)).toEqual(named.slice(0, 2))
    expect(compound).toMatchObject({ requestedSymbols: named.slice(0, 2).map(symbol => ({ symbol, status: "exact" })) })
  })

  it("checks exactly 64 references without claiming truncation", () => {
    const requested = Array.from({ length: 64 }, (_, index) => `Batch.Symbol${index}`)
    const result = search(`Compare ${requested.join(", ")}`, 3)
    expect(result).toMatchObject({ requestedSymbols: requested.map((symbol, index) => ({ symbol, status: index < 3 ? "exact" : "omitted" })) })
    expect(result).not.toHaveProperty("requestedSymbolsTruncated")
  })

  it("checks at most 64 distinct references and exposes the number beyond the bound", () => {
    const requested = Array.from({ length: 65 }, (_, index) => `Batch.Symbol${index}`)
    const result = search(`Compare ${[...requested, requested[64], requested[0]].join(", ")}`, 3)
    expect(result.results.map(item => item.symbol)).toEqual(requested.slice(0, 3))
    expect(result).toMatchObject({
      requestedSymbols: requested.slice(0, 64).map((symbol, index) => ({ symbol, status: index < 3 ? "exact" : "omitted" })),
      requestedSymbolsTruncated: 1
    })
  })
})
