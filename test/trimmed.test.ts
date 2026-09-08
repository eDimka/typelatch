import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type Database from "better-sqlite3"
import type { BenchmarkCase } from "../src/benchmark.js"
import { compareBrainFiles, compressedEmptyFloor, withinLatencyBudget } from "./formatgate.js"
import { createBrainDatabase, emptyBrainFloor } from "../src/database.js"
import { queryBrain } from "../src/query.js"
import type { BrainFormat } from "../src/types.js"

const EDGE_TYPE_IDS: Record<string, number> = {
  accepts: 1,
  returns: 2,
  references: 3,
  delegates_to: 4,
  re_exports: 5
}

type FixtureSymbol = {
  qualifiedName: string
  name: string
  kind: string
  module: string
  signature: string
  docs: string
  sourcePath: string
  lineStart: number
  lineEnd: number
  isPublic: number
  isDeprecated: number
  isInternal: number
  category: string | null
  exampleCount: number
  source: string
}

type FixtureEdge = {
  from: string
  to: string
  type: keyof typeof EDGE_TYPE_IDS
  evidence: string
}

function longSource(seed: number): string {
  const words = ["alpha", "beta", "gamma", "delta"]
  const lines: string[] = []
  for (let line = 0; line < 24; line++) {
    lines.push(`const value${line}_${seed} = compute(${words[line % words.length]}, ${line * (seed + 1)}); // ${"x".repeat(40)}`)
  }
  return lines.join("\n")
}

const coreSymbols: FixtureSymbol[] = [
  {
    qualifiedName: "Effect.Retry",
    name: "Retry",
    kind: "namespace",
    module: "Effect",
    signature: "namespace Retry",
    docs: "Retry option types.",
    sourcePath: "src/Effect.ts",
    lineStart: 10,
    lineEnd: 20,
    isPublic: 1,
    isDeprecated: 0,
    isInternal: 0,
    category: "Error handling",
    exampleCount: 0,
    source: ""
  },
  {
    qualifiedName: "Effect.retry",
    name: "retry",
    kind: "const",
    module: "Effect",
    signature: "retry(policy: Schedule)",
    docs: "Retries an operation using a schedule, including exponential delays.",
    sourcePath: "src/Effect.ts",
    lineStart: 30,
    lineEnd: 40,
    isPublic: 1,
    isDeprecated: 0,
    isInternal: 0,
    category: "Error handling",
    exampleCount: 2,
    source: longSource(1)
  },
  {
    qualifiedName: "Schedule.exponential",
    name: "exponential",
    kind: "const",
    module: "Schedule",
    signature: "exponential(base: Duration)",
    docs: "Creates exponentially increasing retry delays.",
    sourcePath: "src/Schedule.ts",
    lineStart: 50,
    lineEnd: 60,
    isPublic: 1,
    isDeprecated: 0,
    isInternal: 0,
    category: "Constructors",
    exampleCount: 1,
    source: longSource(2)
  }
]

const bulkSymbols: FixtureSymbol[] = Array.from({ length: 12 }, (_, index) => ({
  qualifiedName: `Bulk.Symbol${index}`,
  name: `Symbol${index}`,
  kind: "const",
  module: "Bulk",
  signature: `export const Symbol${index}: string`,
  docs: `Bulk fixture symbol number ${index} for storage parity checks.`,
  sourcePath: `src/Bulk${index}.ts`,
  lineStart: 100 + index * 10,
  lineEnd: 110 + index * 10,
  isPublic: 1,
  isDeprecated: 0,
  isInternal: 0,
  category: index % 2 === 0 ? "Bulk" : null,
  exampleCount: index % 3,
  source: longSource(index + 3)
}))

const fixtureSymbols: FixtureSymbol[] = [...coreSymbols, ...bulkSymbols]

const fixtureEdges: FixtureEdge[] = [
  {
    from: "Effect.retry",
    to: "Schedule.exponential",
    type: "references",
    evidence: `retry policy ${"e".repeat(220)}`
  },
  {
    from: "Bulk.Symbol0",
    to: "Effect.Retry",
    type: "references",
    evidence: `alias edge ${"g".repeat(220)}`
  },
  ...bulkSymbols.map((symbol, index): FixtureEdge => ({
    from: symbol.qualifiedName,
    to: index % 2 === 0 ? "Effect.retry" : "Effect.Retry",
    type: index % 4 === 0 ? "delegates_to" : "references",
    evidence: `edge ${index} ${"f".repeat(220)}`
  }))
]

function searchRow(symbol: FixtureSymbol): [string, string, string] {
  const split = symbol.name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  return [
    `${symbol.qualifiedName} ${split}`,
    `${symbol.docs}\n${symbol.signature}`,
    `${symbol.category ?? ""} ${symbol.kind} ${symbol.isPublic ? "public" : "internal"}`
  ]
}

function internedNodeIds(db: Database.Database, names: Iterable<string>): Map<string, number> {
  const insertNode = db.prepare("INSERT INTO nodes (qualified_name) VALUES (?)")
  const ids = new Map<string, number>()
  for (const name of [...names].sort()) {
    ids.set(name, Number(insertNode.run(name).lastInsertRowid))
  }
  return ids
}

function requiredId(ids: Map<string, number>, name: string): number {
  const id = ids.get(name)
  if (id === undefined) throw new Error(`missing fixture node ${name}`)
  return id
}

function seedFormat(path: string, format: BrainFormat): void {
  const db = createBrainDatabase(path, format)
  try {
    if (format !== "baseline") {
      db.prepare("INSERT INTO metadata (key, value) VALUES ('schemaVersion', ?), ('format', ?)")
        .run(format === "trimmed" ? "3" : "2", format)
    }
    const search = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
    const names = new Set<string>()
    for (const symbol of fixtureSymbols) names.add(symbol.qualifiedName)
    for (const edge of fixtureEdges) {
      names.add(edge.from)
      names.add(edge.to)
    }
    const insertEdge = format === "baseline"
      ? db.prepare("INSERT OR IGNORE INTO edges (from_symbol, to_symbol, type, evidence) VALUES (?, ?, ?, ?)")
      : format === "compact"
        ? db.prepare("INSERT OR IGNORE INTO edges (from_id, type, to_id, evidence) VALUES (?, ?, ?, ?)")
        : db.prepare("INSERT OR IGNORE INTO edges (from_id, type, to_id) VALUES (?, ?, ?)")

    if (format === "baseline") {
      const insert = db.prepare(`
        INSERT INTO symbols (
          qualified_name, name, kind, module, signature, docs, source_path,
          line_start, line_end, source, is_public, is_deprecated, is_internal,
          category, example_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const symbol of fixtureSymbols) {
        const result = insert.run(
          symbol.qualifiedName,
          symbol.name,
          symbol.kind,
          symbol.module,
          symbol.signature,
          symbol.docs,
          symbol.sourcePath,
          symbol.lineStart,
          symbol.lineEnd,
          symbol.source,
          symbol.isPublic,
          symbol.isDeprecated,
          symbol.isInternal,
          symbol.category,
          symbol.exampleCount
        )
        search.run(result.lastInsertRowid, ...searchRow(symbol))
      }
      for (const edge of fixtureEdges) insertEdge.run(edge.from, edge.to, edge.type, edge.evidence)
      return
    }

    const ids = internedNodeIds(db, names)
    const insert = format === "compact"
      ? db.prepare(`
          INSERT INTO symbols (
            id, qualified_name, name, kind, module, signature, docs, source_path,
            line_start, line_end, source, is_public, is_deprecated, is_internal,
            category, example_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
      : db.prepare(`
          INSERT INTO symbols (
            id, name, kind, module, signature, docs, source_path,
            line_start, line_end, is_public, is_deprecated, is_internal,
            category, example_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
    for (const symbol of fixtureSymbols) {
      const id = requiredId(ids, symbol.qualifiedName)
      if (format === "compact") {
        insert.run(
          id,
          symbol.qualifiedName,
          symbol.name,
          symbol.kind,
          symbol.module,
          symbol.signature,
          symbol.docs,
          symbol.sourcePath,
          symbol.lineStart,
          symbol.lineEnd,
          symbol.source,
          symbol.isPublic,
          symbol.isDeprecated,
          symbol.isInternal,
          symbol.category,
          symbol.exampleCount
        )
      } else {
        insert.run(
          id,
          symbol.name,
          symbol.kind,
          symbol.module,
          symbol.signature,
          symbol.docs,
          symbol.sourcePath,
          symbol.lineStart,
          symbol.lineEnd,
          symbol.isPublic,
          symbol.isDeprecated,
          symbol.isInternal,
          symbol.category,
          symbol.exampleCount
        )
      }
      search.run(id, ...searchRow(symbol))
    }
    for (const edge of fixtureEdges) {
      if (format === "compact") {
        insertEdge.run(requiredId(ids, edge.from), EDGE_TYPE_IDS[edge.type], requiredId(ids, edge.to), edge.evidence)
      } else {
        insertEdge.run(requiredId(ids, edge.from), EDGE_TYPE_IDS[edge.type], requiredId(ids, edge.to))
      }
    }
  } finally {
    db.close()
  }
}

describe("trimmed format", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "apirova-trimmed-"))
  const baselinePath = join(temporaryHome, "baseline.db")
  const compactPath = join(temporaryHome, "compact.db")
  const trimmedPath = join(temporaryHome, "trimmed.db")
  const previousHome = process.env.APIROVA_HOME
  const version = "1.0.0"
  const packageName = "trimfixture"

  beforeAll(() => {
    process.env.APIROVA_HOME = temporaryHome
    seedFormat(baselinePath, "baseline")
    seedFormat(compactPath, "compact")
    seedFormat(trimmedPath, "trimmed")
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.APIROVA_HOME
    else process.env.APIROVA_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  it("returns identical exact, case-insensitive, and hybrid results across compact and trimmed", () => {
    for (const question of ["Effect.retry", "effect.retry", "retry with exponential delay"]) {
      const compact = queryBrain(packageName, question, { version, brainFile: compactPath, recordUsage: false })
      const trimmed = queryBrain(packageName, question, { version, brainFile: trimmedPath, recordUsage: false })
      expect(trimmed.results).toEqual(compact.results)
      expect(compact.results).toEqual(
        queryBrain(packageName, question, { version, brainFile: baselinePath, recordUsage: false }).results
      )
    }
    const exact = queryBrain(packageName, "Effect.retry", { version, brainFile: trimmedPath, recordUsage: false })
    expect(exact.strategy).toBe("exact")
    expect(exact.results[0]?.symbol).toBe("Effect.retry")
    const hybrid = queryBrain(packageName, "retry with exponential delay", { version, brainFile: trimmedPath, recordUsage: false })
    expect(hybrid.strategy).toBe("hybrid")
    expect(new Set(hybrid.results.slice(0, 2).map((result) => result.symbol))).toEqual(
      new Set(["Effect.retry", "Schedule.exponential"])
    )
  })

  it("returns identical relationships across compact and trimmed", () => {
    const compact = queryBrain(packageName, "Effect.retry", { version, brainFile: compactPath, recordUsage: false })
    const trimmed = queryBrain(packageName, "Effect.retry", { version, brainFile: trimmedPath, recordUsage: false })
    expect(trimmed.results[0]?.relationships).toEqual(compact.results[0]?.relationships)
    expect(trimmed.results[0]?.relationships).toEqual([{ type: "references", target: "Schedule.exponential" }])
    const compactBulk = queryBrain(packageName, "Bulk.Symbol0", { version, brainFile: compactPath, recordUsage: false })
    const trimmedBulk = queryBrain(packageName, "Bulk.Symbol0", { version, brainFile: trimmedPath, recordUsage: false })
    expect(trimmedBulk.results[0]?.relationships).toEqual(compactBulk.results[0]?.relationships)
    expect(trimmedBulk.results[0]?.relationships).toEqual([
      { type: "delegates_to", target: "Effect.retry" },
      { type: "references", target: "Effect.Retry" }
    ])
  })

  it("stores a strictly smaller file than compact for identical logical content", () => {
    const compactBytes = statSync(compactPath).size
    const trimmedBytes = statSync(trimmedPath).size
    expect(trimmedBytes).toBeLessThan(compactBytes)
    expect(1 - trimmedBytes / compactBytes).toBeGreaterThanOrEqual(0.25)
  })

  it("passes the trimmed-vs-compact gate through the comparison glue", () => {
    const cases: BenchmarkCase[] = [
      { question: "Effect.retry", expected: ["Effect.retry"] },
      { question: "retry with exponential delay", expected: ["Effect.retry", "Schedule.exponential"] },
      { question: "zabbit quarble flibbertigibbet", expected: ["Bulk.Symbol3"] }
    ]
    const report = compareBrainFiles({
      packageName,
      version,
      integrity: "sha512-fixture",
      reference: { path: compactPath, format: "compact" },
      candidate: { path: trimmedPath, format: "trimmed" },
      cases,
      rounds: 30,
      minimumSizeReduction: 0.25,
      minimumCompressedSizeReduction: 0.15,
      // Latency on a toy fixture is scheduler/GC noise (sub-millisecond medians,
      // spiky p95), so the glue tests loosen the timing gate; the production
      // max(1.10x, +0.25 ms) budget still applies by default everywhere else,
      // including the CLI verification runs.
      maximumLatencyRatio: 100,
      latencyJitterAllowanceMs: 1000
    })
    expect(report.referenceFormat).toBe("compact")
    expect(report.candidateFormat).toBe("trimmed")
    expect(report.precision.trimmedByDesign).toBe(true)
    expect(report.precision.contentIdentical).toBe(true)
    expect(report.precision.graphIdentical).toBe(true)
    expect(report.precision.rankingsIdentical).toBe(true)
    expect(report.precision.differingQueries).toEqual([])
    expect(report.precision.recallNotWorse).toBe(true)
    expect(report.precision.meanReciprocalRankNotWorse).toBe(true)
    expect(report.gates.installedSize).toBe(true)
    expect(report.improvement.sizeReduction).toBeGreaterThanOrEqual(0.25)
    expect(report.gates.passed).toBe(true)
  })

  it("honors caller-provided size thresholds in the comparison glue", () => {
    const cases: BenchmarkCase[] = [{ question: "Effect.retry", expected: ["Effect.retry"] }]
    const input = {
      packageName,
      version,
      integrity: "sha512-fixture",
      reference: { path: compactPath, format: "compact" },
      candidate: { path: trimmedPath, format: "trimmed" },
      cases,
      rounds: 30,
      maximumLatencyRatio: 100,
      latencyJitterAllowanceMs: 1000
    }
    const lenient = compareBrainFiles({ ...input, minimumSizeReduction: 0.05, minimumCompressedSizeReduction: 0.01 })
    expect(lenient.gates.passed).toBe(true)
    expect(lenient.gates.thresholds.minimumSizeReduction).toBe(0.05)
    expect(lenient.gates.thresholds.maximumLatencyRatio).toBe(100)
    const impossible = compareBrainFiles({ ...input, minimumSizeReduction: 0.9, minimumCompressedSizeReduction: 0.9 })
    expect(impossible.gates.installedSize).toBe(false)
    expect(impossible.gates.passed).toBe(false)
  })

  it("measures size gates against the bytes above provided floors", () => {
    const cases: BenchmarkCase[] = [{ question: "Effect.retry", expected: ["Effect.retry"] }]
    const input = {
      packageName,
      version,
      integrity: "sha512-fixture",
      reference: { path: compactPath, format: "compact" },
      candidate: { path: trimmedPath, format: "trimmed" },
      cases,
      rounds: 30,
      maximumLatencyRatio: 100,
      latencyJitterAllowanceMs: 1000
    }
    // Empty schema floors must fit within the fixture.
    // a tiny fixture can land exactly on the floor) and its compressed
    // counterpart when zstd is available.
    const floor = emptyBrainFloor("trimmed")
    expect(floor).toBeGreaterThan(0)
    expect(floor).toBeLessThanOrEqual(statSync(trimmedPath).size)
    const floored = compareBrainFiles({
      ...input,
      minimumSizeReduction: 0.9,
      minimumCompressedSizeReduction: 0.9,
      sizeFloorBytes: floor,
      compressedFloorBytes: compressedEmptyFloor("trimmed")
    })
    expect(floored.improvement.controllableSizeReduction).not.toBeNull()
    expect(floored.gates.thresholds.sizeFloorBytes).toBe(floor)
    expect(floored.gates.thresholds.compressedFloorBytes ?? 0).toBeGreaterThan(0)
    // Synthetic floors just below the reference sizes force the above-floor
    // reduction toward 1, so even a 0.9 target passes via the floor-aware leg.
    const forced = compareBrainFiles({
      ...input,
      minimumSizeReduction: 0.9,
      minimumCompressedSizeReduction: 0.9,
      sizeFloorBytes: statSync(compactPath).size - 1,
      compressedFloorBytes: compressedEmptyFloor("trimmed") === null ? null : 1
    })
    expect(forced.gates.installedSize).toBe(true)
    // A floor at or above the reference disables the leg: raw gate semantics apply.
    const degenerate = compareBrainFiles({ ...input, minimumSizeReduction: 0.9, minimumCompressedSizeReduction: 0.9, sizeFloorBytes: statSync(compactPath).size + 1000 })
    expect(degenerate.improvement.controllableSizeReduction).toBeNull()
    expect(degenerate.gates.installedSize).toBe(false)
  })

  it("governs the latency budget by the absolute leg below the ratio floor", () => {
    const ratio = 1.10
    const jitter = 0.25
    expect(withinLatencyBudget(1.05, 1.0, ratio, jitter)).toBe(true)
    expect(withinLatencyBudget(1.30, 1.0, ratio, jitter)).toBe(false)
    expect(withinLatencyBudget(2.15, 2.0, ratio, jitter)).toBe(true)
    expect(withinLatencyBudget(3.20, 3.0, ratio, jitter)).toBe(true)
    expect(withinLatencyBudget(3.40, 3.0, ratio, jitter)).toBe(false)
    expect(withinLatencyBudget(5.40, 5.0, ratio, jitter)).toBe(false)
  })
})
