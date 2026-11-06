import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { getSymbol, queryBrain } from "../src/query.js"
import type { BrainFormat, QueryResponse } from "../src/types.js"

// Emitted by the retained 0.2.1 builder from the generic local fixture.
// Acquisition and complete generated databases are retained in the identity audit.
const legacyMetadata: Record<BrainFormat, Record<string, string>> = {
  "baseline": {
    "schemaVersion": "1",
    "format": "baseline",
    "package": "cache-fixture",
    "version": "1.2.3",
    "integrity": "sha512-cdkzcdle2sHHuuqv7P3CEYFe6PYsnt2Bv2B3f+zockPay677ooKFPbaRz+GDF8WAqCVXwaJa4KIaGJEeBqMsgQ==",
    "generatedAt": "2026-10-06T20:17:30.403Z",
    "generator": "typelatch-indexer/0.2.1",
    "sourceBytes": "200",
    "files": "1",
    "symbols": "1",
    "publicSymbols": "1",
    "relationships": "0",
    "examples": "0",
    "deprecatedSymbols": "0",
    "internalSymbols": "0",
    "brainBytes": "61440"
  },
  "compact": {
    "schemaVersion": "2",
    "format": "compact",
    "package": "cache-fixture",
    "version": "1.2.3",
    "integrity": "sha512-cdkzcdle2sHHuuqv7P3CEYFe6PYsnt2Bv2B3f+zockPay677ooKFPbaRz+GDF8WAqCVXwaJa4KIaGJEeBqMsgQ==",
    "generatedAt": "2026-10-06T20:17:30.421Z",
    "generator": "typelatch-indexer/0.2.1",
    "sourceBytes": "200",
    "files": "1",
    "symbols": "1",
    "publicSymbols": "1",
    "relationships": "0",
    "examples": "0",
    "deprecatedSymbols": "0",
    "internalSymbols": "0",
    "brainBytes": "61440"
  },
  "trimmed": {
    "schemaVersion": "3",
    "format": "trimmed",
    "package": "cache-fixture",
    "version": "1.2.3",
    "integrity": "sha512-cdkzcdle2sHHuuqv7P3CEYFe6PYsnt2Bv2B3f+zockPay677ooKFPbaRz+GDF8WAqCVXwaJa4KIaGJEeBqMsgQ==",
    "generatedAt": "2026-10-06T20:17:30.427Z",
    "generator": "typelatch-indexer/0.2.1",
    "sourceBytes": "200",
    "files": "1",
    "symbols": "1",
    "publicSymbols": "1",
    "relationships": "0",
    "examples": "0",
    "deprecatedSymbols": "0",
    "internalSymbols": "0",
    "brainBytes": "53248"
  }
}

const formats: BrainFormat[] = ["baseline", "compact", "trimmed"]
const mutations: Array<{ name: string; key: string; value: string | null }> = [
  { name: "wrong package", key: "package", value: "another-package" },
  { name: "wrong version", key: "version", value: "9.9.9" },
  { name: "missing package", key: "package", value: null },
  { name: "missing version", key: "version", value: null },
  { name: "missing integrity", key: "integrity", value: null },
  { name: "empty package", key: "package", value: "" },
  { name: "empty version", key: "version", value: "" },
  { name: "empty integrity", key: "integrity", value: "" },
  { name: "whitespace integrity", key: "integrity", value: " \t\n" }
]
const observations: unknown[] = []
const routes = ["library_search", "library_symbol"] as const
let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "typelatch-cache-identity-"))
  vi.stubEnv("TYPELATCH_HOME", home)
  vi.stubEnv("TYPELATCH_USAGE", "off")
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})
afterAll(() => {
  const evidence = process.env.TYPELATCH_IDENTITY_TEST_EVIDENCE
  if (evidence) writeFileSync(evidence, JSON.stringify(observations, null, 2) + "\n")
})

function seed(format: BrainFormat, metadata: Record<string, string>, packageName = "effect", version = "3.22.1"): string {
  const file = brainPath(packageName, version)
  mkdirSync(dirname(file), { recursive: true })
  const db = createBrainDatabase(file, format)
  try {
    for (const [key, value] of Object.entries(metadata)) db.prepare("INSERT INTO metadata VALUES (?, ?)").run(key, value)
    if (format !== "baseline") db.prepare("INSERT INTO nodes VALUES (1, 'Foreign.marker')").run()
    const identity = format === "trimmed" ? "" : "qualified_name,"
    const source = format === "trimmed" ? "" : "source,"
    const values = [1, ...(format === "trimmed" ? [] : ["Foreign.marker"]), "marker", "function", "Foreign",
      "export declare function marker(): string", "Foreign cache identity marker documentation.", "foreign.d.ts", 1, 1,
      ...(format === "trimmed" ? [] : [""]), 1, 0, 0, null, 0]
    db.prepare(`INSERT INTO symbols (id,${identity}name,kind,module,signature,docs,source_path,line_start,line_end,${source}is_public,is_deprecated,is_internal,category,example_count) VALUES (${values.map(() => "?").join(",")})`).run(...values)
    db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (1, 'Foreign.marker marker', 'Foreign cache identity marker documentation', 'public')").run()
  } finally { db.close() }
  return file
}

function invalidMetadata(format: BrainFormat, mutation: typeof mutations[number]): Record<string, string> {
  const metadata = { ...legacyMetadata[format], package: "effect", version: "3.22.1" }
  if (mutation.value === null) delete metadata[mutation.key]
  else metadata[mutation.key] = mutation.value
  return metadata
}
function read(route: typeof routes[number], packageName = "effect", version: string | null = "3.22.1", brainFile?: string) {
  const options = { ...(version === null ? {} : { version }), ...(brainFile === undefined ? {} : { brainFile }), recordUsage: false }
  return route === "library_search" ? queryBrain(packageName, "Foreign.marker", options) : getSymbol(packageName, "Foreign.marker", options)
}
function capture(action: () => QueryResponse) {
  try { return { response: action(), error: null } }
  catch (error) { return { response: null, error: error instanceof Error ? error.message : String(error) } }
}

describe.each(formats)("managed package identity in %s storage", format => {
  describe.each(routes)("%s", route => {
    it.each(mutations)("rejects $name metadata before labeling results", mutation => {
      const metadata = invalidMetadata(format, mutation)
      seed(format, metadata)
      const observed = capture(() => read(route))
      observations.push({ format, route, case: mutation.name, metadata, observed })
      expect(observed.error).toMatch(/metadata|identity|integrity/i)
      expect(observed.error).toContain("effect@3.22.1")
      expect(observed.error).toContain("typelatch add effect@3.22.1")
      expect(observed.response).toBeNull()
    })

    it("checks identity when the version is selected from the newest managed directory", () => {
      const metadata = invalidMetadata(format, mutations[1]!)
      seed(format, metadata)
      const observed = capture(() => read(route, "effect", null))
      observations.push({ format, route, case: "implicit newest version", metadata, observed })
      expect(observed.error).toMatch(/metadata|identity|integrity/i)
    })

    it("accepts matching identity metadata emitted by the legacy builder", () => {
      const metadata = legacyMetadata[format]
      seed(format, metadata, metadata.package!, metadata.version!)
      const observed = read(route, metadata.package!, metadata.version!)
      expect(observed).toMatchObject({ package: "cache-fixture", version: "1.2.3" })
      expect(observed.results.map(row => row.symbol)).toEqual(["Foreign.marker"])
      observations.push({ format, route, case: "valid legacy metadata", observed })
    })

    it("preserves SQL errors when the metadata table is missing", () => {
      const metadata = { ...legacyMetadata[format], package: "effect", version: "3.22.1" }
      const file = seed(format, metadata)
      const db = createBrainDatabase(file, format)
      db.exec("DROP TABLE metadata")
      db.close()
      const observed = capture(() => read(route))
      expect(observed.error).toMatch(/no such table: metadata/i)
      expect(observed.error).not.toMatch(/No brain installed|typelatch add/)
    })

    it("preserves unsupported schema errors for a matching managed identity", () => {
      seed(format, { ...legacyMetadata[format], package: "effect", version: "3.22.1", schemaVersion: "99" })
      expect(() => read(route)).toThrow("Unsupported brain schema 99")
    })

    it("preserves the explicit internal brainFile fixture override", () => {
      for (const mutation of mutations) {
        const file = seed(format, invalidMetadata(format, mutation), "fixture-holder", `1.0.${mutations.indexOf(mutation)}`)
        const observed = read(route, "internal-fixture", "0.0.1", file)
        expect(observed).toMatchObject({ package: "internal-fixture", version: "0.0.1" })
        expect(observed.results.map(row => row.symbol)).toEqual(["Foreign.marker"])
      }
    })
  })

  it("returns public MCP errors for the mismatched cache instead of mislabeled successful evidence", async () => {
    const metadata = invalidMetadata(format, mutations[0]!)
    seed(format, metadata)
    const transport = new StdioClientTransport({
      command: process.execPath, args: ["--import", "tsx", resolve("src/mcp.ts")],
      env: { ...process.env, TYPELATCH_HOME: home, TYPELATCH_USAGE: "off" }, stderr: "pipe"
    })
    const client = new Client({ name: "library-cache-identity-test", version: "1.0.0" })
    try {
      await client.connect(transport)
      for (const route of routes) {
        const request = { name: route, arguments: { package: "effect", version: "3.22.1", ...(route === "library_search" ? { question: "Foreign.marker" } : { symbol: "Foreign.marker" }) } }
        const response = await client.callTool(request)
        observations.push({ format, route, case: "actual MCP wrong package", metadata, request, response })
        expect.soft(response.isError).toBe(true)
        expect.soft(response.structuredContent).toBeUndefined()
      }
    } finally { await client.close() }
  }, 15000)
})

it.each(routes)("%s accepts valid legacy baseline identity without newer schema or format tags", route => {
  const metadata = { ...legacyMetadata.baseline }
  delete metadata.schemaVersion
  delete metadata.format
  seed("baseline", metadata, metadata.package!, metadata.version!)
  expect(read(route, metadata.package!, metadata.version!).results.map(row => row.symbol)).toEqual(["Foreign.marker"])
})
