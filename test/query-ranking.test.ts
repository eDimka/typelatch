import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { queryBrain } from "../src/query.js"

type Entry = { name: string; kind: string; docs: string; signature: string; module?: string }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function rankings(entries: Entry[], question: string, limit = 10) {
  const root = mkdtempSync(join(tmpdir(), "brain-ranking-audit-"))
  roots.push(root)
  return (["baseline", "compact"] as const).map(format => {
    const file = join(root, `${format}.db`)
    const db = createBrainDatabase(file, format)
    db.prepare("INSERT INTO metadata(key,value) VALUES ('format',?),('schemaVersion',?)").run(format, format === "baseline" ? "1" : "2")
    for (const [index, entry] of entries.entries()) {
      const module = entry.module ?? "api"
      const qualified = `${module}.${entry.name}`
      if (format === "compact") db.prepare("INSERT INTO nodes(id,qualified_name) VALUES (?,?)").run(index + 1, qualified)
      db.prepare("INSERT INTO symbols(id,qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count) VALUES (?,?,?,?,?,?,?,'index.d.ts',1,1,'',1,0,0,NULL,0)").run(index + 1, qualified, entry.name, entry.kind, module, entry.signature, entry.docs)
      const splitName = entry.name.replace(/([a-z])([A-Z])/g, "$1 $2")
      db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (?,?,?,'public')").run(index + 1, `${qualified} ${splitName}`, `${entry.docs}\n${entry.signature}`)
    }
    db.close()
    return queryBrain("unknown-audit-package", question, { version: "1.0.0", brainFile: file, recordUsage: false, limit }).results.map(result => result.symbol)
  })
}

describe("independent ranking controls outside the package corpus", () => {
  it("prefers the constructible API for creation while retaining its matching type", () => {
    const results = rankings([
      { name: "DecoderOptions", kind: "interface", signature: "interface DecoderOptions {}", docs: "Decoder configuration." },
      { name: "Decoder", kind: "const", signature: "export const Decoder: new (options: DecoderOptions) => object", docs: "Decoder configuration." }
    ], "How do I create a decoder?")
    for (const ranking of results) expect(ranking).toEqual(["api.Decoder", "api.DecoderOptions"])
  })

  it("matches inflected camel-case type names without promoting generic prose filler", () => {
    const results = rankings([
      { name: "ParseOptions", kind: "interface", signature: "interface ParseOptions {}", docs: "Configuration of command arguments." },
      { name: "Guide", kind: "class", signature: "class Guide {}", docs: "What can I use on my options? Which can be at this or that?" }
    ], "Which options can I use when parsing?")
    for (const ranking of results) expect(ranking[0]).toBe("api.ParseOptions")
  })

  it("does not infer construction merely because an existing value is reused", () => {
    const entries = [
      { name: "existing", kind: "const", signature: "const existing: object", docs: "Connection pool returns a retained object." },
      { name: "Connection", kind: "class", signature: "class Connection {}", docs: "Connection constructor creates a new object." }
    ]
    const neutral = rankings(entries, "connection pool retained object")
    const reuse = rankings(entries, "reuse connection pool retained object")
    expect(reuse).toEqual(neutral)
    for (const ranking of reuse) expect(ranking).toContain("api.existing")
  })

  it("prefers a public mirror but keeps the vendored declaration discoverable", () => {
    const results = rankings([
      { name: "decode", kind: "function", module: "vendor/codec", signature: "function decode()", docs: "Decode a binary packet." },
      { name: "decode", kind: "function", module: "api", signature: "function decode()", docs: "Decode a binary packet." }
    ], "decode binary packet")
    for (const ranking of results) expect(ranking).toEqual(["api.decode", "vendor/codec.decode"])
  })

  it("retains numeric query evidence that distinguishes supported protocol versions", () => {
    const entries = [
      { name: "Legacy", kind: "interface", signature: "interface Legacy {}", docs: "Protocol 16." },
      { name: "Modern", kind: "interface", signature: "interface Modern {}", docs: "Protocol 256." }
    ]
    for (const ranking of rankings(entries, "256")) expect(ranking).toEqual(["api.Modern"])
    for (const ranking of rankings(entries, "16")) expect(ranking).toEqual(["api.Legacy"])
  })

  it("recognizes a callable interface without excluding other interface results", () => {
    const entries = [
      { name: "AShape", kind: "interface", signature: "export interface AShape { value: string; result: string; }", docs: "Render document bytes." },
      { name: "ZShape", kind: "interface", signature: "export interface ZShape { (value: string): string; }", docs: "Render document bytes." }
    ]
    for (const ranking of rankings(entries, "render document bytes")) expect(ranking[0]).toBe("api.ZShape")
    // Explicit type questions retain both candidate kinds.
    for (const ranking of rankings(entries, "type render document bytes")) expect(new Set(ranking)).toEqual(new Set(["api.AShape", "api.ZShape"]))
  })

  it("bounds duplicate API shapes without removing distinct overloads or exact lookup access", () => {
    const entries: Entry[] = Array.from({ length: 6 }, (_, index) => ({ name: "decode", kind: "function", module: `variant${index}`, signature: "function decode(value: string): string", docs: "Decode protocol packet." }))
    entries.push({ name: "decode", kind: "function", module: "binary", signature: "function decode(value: Uint8Array): string", docs: "Decode protocol packet." })
    entries.push({ name: "inspect", kind: "function", signature: "function inspect(): string", docs: "Decode protocol packet." })
    for (const ranking of rankings(entries, "decode protocol packet", 5)) {
      expect(ranking.filter(symbol => symbol.startsWith("variant"))).toHaveLength(2)
      expect(ranking).toContain("binary.decode")
      expect(ranking).toContain("api.inspect")
    }
    // Shortlist diversity is not deletion or a semantic-equivalence assertion.
    for (const ranking of rankings(entries, "variant5.decode", 10)) expect(ranking[0]).toBe("variant5.decode")
  })
})
