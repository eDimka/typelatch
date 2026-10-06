import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { getSymbol } from "../src/query.js"
import type { BrainFormat } from "../src/types.js"

describe.each<BrainFormat>(["baseline", "compact", "trimmed"])("exact symbol identity in %s storage", format => {
  const directory = mkdtempSync(join(tmpdir(), "typelatch-symbol-identity-"))
  const brainFile = join(directory, "brain.db")
  const options = { version: "1.2.3", brainFile, recordUsage: false }

  beforeAll(() => {
    const db = createBrainDatabase(brainFile, format)
    db.prepare("INSERT INTO metadata VALUES ('format',?),('schemaVersion',?)").run(format, String(["baseline", "compact", "trimmed"].indexOf(format) + 1))
    const entries = ["esm/codec.decode", "cjs/codec.decode", "esm/codec.Decode", "other/parser.decode"]
    for (const [index, qualified] of entries.entries()) {
      const id = index + 1
      const name = qualified.split(".").at(-1)!
      const module = qualified.slice(0, qualified.lastIndexOf("."))
      if (format !== "baseline") db.prepare("INSERT INTO nodes VALUES (?,?)").run(id, qualified)
      const identityColumn = format === "trimmed" ? "" : "qualified_name,"
      const sourceColumn = format === "trimmed" ? "" : "source,"
      const identityValue = format === "trimmed" ? [] : [qualified]
      const sourceValue = format === "trimmed" ? [] : [""]
      const values = [id, ...identityValue, name, "function", module, `function ${name}(value: string): string`, "Decode a packet.", `${module}.d.ts`, 10, 10, ...sourceValue, 1, 0, 0, null, 0]
      db.prepare(`INSERT INTO symbols(id,${identityColumn}name,kind,module,signature,docs,source_path,line_start,line_end,${sourceColumn}is_public,is_deprecated,is_internal,category,example_count) VALUES (${values.map(() => "?").join(",")})`).run(...values)
    }
    if (format === "baseline") db.prepare("INSERT INTO edges(from_symbol,to_symbol,type,evidence) VALUES ('esm/codec.decode','esm/codec.Decode','references','fixture')").run()
    else if (format === "compact") db.prepare("INSERT INTO edges(from_id,to_id,type,evidence) VALUES (1,3,3,'fixture')").run()
    else db.prepare("INSERT INTO edges(from_id,to_id,type) VALUES (1,3,3)").run()
    db.close()
  })

  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  it("returns only the exact qualified symbol without same-name or case variants", () => {
    const result = getSymbol("fixture-codec", "esm/codec.decode", options)
    expect(result.results.map(item => item.symbol)).toEqual(["esm/codec.decode"])
    expect(result.results[0]?.relationships).toEqual([{ type: "references", target: "esm/codec.Decode" }])
    expect(result.lookup).toEqual({ status: "exact", matchedBy: "qualified-name", totalMatches: 1, omitted: 0 })
    expect(result).toMatchObject({ package: "fixture-codec", version: "1.2.3", strategy: "exact", fallback: null })
  })

  it("does not substitute another module or case when the qualified identity is absent", () => {
    for (const symbol of ["missing/module.decode", "esm/codec.DECODE"]) {
      const result = getSymbol("fixture-codec", symbol, options)
      expect(result.results).toEqual([])
      expect(result.lookup).toEqual({ status: "not-found", matchedBy: null, totalMatches: 0, omitted: 0 })
      expect(result.fallback).toContain("was not found")
    }
  })

  it("keeps bare-name ambiguity explicit even when the result limit hides candidates", () => {
    const result = getSymbol("fixture-codec", "decode", { ...options, limit: 1 })
    expect(result.results).toHaveLength(1)
    expect(result.lookup).toEqual({ status: "ambiguous", matchedBy: "bare-name", totalMatches: 3, omitted: 2 })
    const complete = getSymbol("fixture-codec", "decode", options)
    expect(complete.results.map(item => item.symbol)).toEqual(["cjs/codec.decode", "esm/codec.decode", "other/parser.decode"])
  })

  it("preserves symbol case for bare names too", () => {
    const result = getSymbol("fixture-codec", "Decode", options)
    expect(result.results.map(item => item.symbol)).toEqual(["esm/codec.Decode"])
    expect(result.lookup).toEqual({ status: "exact", matchedBy: "bare-name", totalMatches: 1, omitted: 0 })
  })
})
