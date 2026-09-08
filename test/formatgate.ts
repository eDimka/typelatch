import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { runBenchmark, type BenchmarkCase, type BenchmarkReport } from "../src/benchmark.js"
import { corpusCaseFile } from "../src/benchmark/corpus.js"
import { createBrainDatabase } from "../src/database.js"
import { buildBrain } from "../src/indexer.js"
import { queryBrain } from "../src/query.js"
import type { BrainFormat } from "../src/types.js"

const DEFAULT_MINIMUM_SIZE_REDUCTION = 0.15
const DEFAULT_MINIMUM_COMPRESSED_SIZE_REDUCTION = 0.05
const MAXIMUM_LATENCY_RATIO = 1.10
const LATENCY_JITTER_ALLOWANCE_MS = 0.25

const compressedFloorCache = new Map<BrainFormat, number | null>()

/**
 * Zstandard-compressed size of a freshly created, completely empty brain of
 * the given format: the compressed floor no column-level lever can remove.
 * Used to make compressed-size gates floor-aware for small brains, mirroring
 * emptyBrainFloor for installed bytes. Null when zstd is unavailable.
 */
export function compressedEmptyFloor(format: BrainFormat): number | null {
  if (compressedFloorCache.has(format)) return compressedFloorCache.get(format) ?? null
  const directory = mkdtempSync(join(tmpdir(), "apirova-cfloor-"))
  const path = join(directory, "empty.db")
  try {
    const db = createBrainDatabase(path, format)
    db.pragma("journal_mode = DELETE")
    db.exec("VACUUM")
    db.close()
    const value = compressedSize(path)
    compressedFloorCache.set(format, value)
    return value
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export type FormatComparison = {
  generatedAt: string
  package: string
  version: string
  integrity: string
  rounds: number
  referenceFormat?: BrainFormat
  candidateFormat?: BrainFormat
  // The field names below are historical: `baseline` holds the reference
  // measurement and `compact` holds the candidate measurement regardless of
  // which formats were compared. See referenceFormat/candidateFormat.
  baseline: FormatMeasurement
  compact: FormatMeasurement
  improvement: {
    bytesSaved: number
    sizeReduction: number
    /** Reduction measured against the bytes above sizeFloorBytes, when a floor was provided. */
    controllableSizeReduction: number | null
    /** Reduction measured against the compressed bytes above compressedFloorBytes, when provided. */
    controllableCompressedSizeReduction: number | null
    compressedBytesSaved: number | null
    compressedSizeReduction: number | null
    medianLatencyRatio: number
    p95LatencyRatio: number
  }
  precision: {
    contentIdentical: boolean
    graphIdentical: boolean
    rankingsIdentical: boolean
    differingQueries: string[]
    recallNotWorse: boolean
    meanReciprocalRankNotWorse: boolean
    trimmedByDesign?: boolean
  }
  gates: {
    installedSize: boolean
    compressedSize: boolean
    size: boolean
    precision: boolean
    performance: boolean
    passed: boolean
    thresholds: {
      minimumSizeReduction: number
      minimumCompressedSizeReduction: number
      maximumLatencyRatio: number
      latencyJitterAllowanceMs: number
      sizeFloorBytes: number | null
      compressedFloorBytes: number | null
    }
  }
}

type FormatMeasurement = {
  bytes: number
  compressedBytes: number | null
  benchmark: BenchmarkReport
  latency: { medianMs: number; p95Ms: number; samples: number }
}

export type CompareFormatsOptions = {
  rounds?: number
  reference?: BrainFormat
  candidate?: BrainFormat
  minimumSizeReduction?: number
  minimumCompressedSizeReduction?: number
  maximumLatencyRatio?: number
  latencyJitterAllowanceMs?: number
  /** Empty-database floor of the candidate format; enables floor-aware size gating for small brains. */
  sizeFloorBytes?: number
  /** Compressed empty-database floor (null when zstd is unavailable); enables floor-aware compressed gating. */
  compressedFloorBytes?: number | null
  onProgress?: (phase: string) => void
}

export async function compareFormats(
  spec: string,
  options: CompareFormatsOptions = {}
): Promise<FormatComparison> {
  const rounds = options.rounds ?? 30
  if (!Number.isInteger(rounds) || rounds < 5 || rounds > 200) throw new Error("comparison rounds must be an integer from 5 to 200")
  const referenceFormat = options.reference ?? "baseline"
  const candidateFormat = options.candidate ?? "compact"
  const packageName = specName(spec)
  const cases = corpusCaseFile(packageName)
  const directory = await mkdtemp(join(tmpdir(), "apirova-compare-"))
  const referencePath = join(directory, `${referenceFormat}.db`)
  const candidatePath = join(directory, `${candidateFormat}.db`)
  try {
    options.onProgress?.(`Building ${referenceFormat} schema`)
    const referenceBuild = await buildBrain(spec, {
      output: referencePath,
      format: referenceFormat,
      onProgress: (phase) => options.onProgress?.(`${referenceFormat}: ${phase}`)
    })
    options.onProgress?.(`Building ${candidateFormat} schema`)
    const candidateBuild = await buildBrain(spec, {
      output: candidatePath,
      format: candidateFormat,
      onProgress: (phase) => options.onProgress?.(`${candidateFormat}: ${phase}`)
    })
    if (referenceBuild.metadata.integrity !== candidateBuild.metadata.integrity) {
      throw new Error(`${referenceFormat} and ${candidateFormat} builds did not use the same npm artifact`)
    }
    return compareBrainFiles({
      packageName,
      version: referenceBuild.metadata.version,
      integrity: referenceBuild.metadata.integrity,
      reference: { path: referencePath, format: referenceFormat },
      candidate: { path: candidatePath, format: candidateFormat },
      cases,
      rounds,
      minimumSizeReduction: options.minimumSizeReduction ?? DEFAULT_MINIMUM_SIZE_REDUCTION,
      minimumCompressedSizeReduction: options.minimumCompressedSizeReduction ?? DEFAULT_MINIMUM_COMPRESSED_SIZE_REDUCTION,
      maximumLatencyRatio: options.maximumLatencyRatio ?? MAXIMUM_LATENCY_RATIO,
      latencyJitterAllowanceMs: options.latencyJitterAllowanceMs ?? LATENCY_JITTER_ALLOWANCE_MS,
      ...(options.sizeFloorBytes !== undefined ? { sizeFloorBytes: options.sizeFloorBytes } : {}),
      ...(options.compressedFloorBytes != null ? { compressedFloorBytes: options.compressedFloorBytes } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {})
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export type CompareBrainFilesInput = {
  packageName: string
  version: string
  integrity: string
  reference: { path: string; format: BrainFormat }
  candidate: { path: string; format: BrainFormat }
  cases: readonly BenchmarkCase[]
  rounds: number
  minimumSizeReduction: number
  minimumCompressedSizeReduction: number
  maximumLatencyRatio?: number
  latencyJitterAllowanceMs?: number
  sizeFloorBytes?: number
  compressedFloorBytes?: number | null
  onProgress?: (phase: string) => void
}

export function compareBrainFiles(input: CompareBrainFilesInput): FormatComparison {
  const { packageName, version, rounds } = input
  const referencePath = input.reference.path
  const candidatePath = input.candidate.path
  input.onProgress?.("Checking retrieval precision parity")
  const referenceBenchmark = runBenchmark(packageName, input.cases, { version, brainFile: referencePath })
  const candidateBenchmark = runBenchmark(packageName, input.cases, { version, brainFile: candidatePath })
  const differingQueries = referenceBenchmark.results
    .filter((result, index) => JSON.stringify(result.returned) !== JSON.stringify(candidateBenchmark.results[index]?.returned))
    .map((result) => result.question)
  const representation = compareRepresentation(referencePath, input.reference.format, candidatePath, input.candidate.format)

  input.onProgress?.(`Measuring latency over ${rounds} interleaved rounds`)
  const latency = measureInterleavedLatency(packageName, input.cases, version, referencePath, candidatePath, rounds)
  const referenceBytes = statSync(referencePath).size
  const candidateBytes = statSync(candidatePath).size
  const referenceCompressed = compressedSize(referencePath)
  const candidateCompressed = compressedSize(candidatePath)
  const sizeReduction = 1 - candidateBytes / referenceBytes
  const controllableSizeReduction = input.sizeFloorBytes !== undefined && input.sizeFloorBytes < referenceBytes
    ? (referenceBytes - candidateBytes) / (referenceBytes - input.sizeFloorBytes)
    : null
  const compressedSizeReduction = referenceCompressed === null || candidateCompressed === null
    ? null
    : 1 - candidateCompressed / referenceCompressed
  const controllableCompressedSizeReduction =
    input.compressedFloorBytes != null &&
    referenceCompressed !== null &&
    candidateCompressed !== null &&
    input.compressedFloorBytes < referenceCompressed
      ? (referenceCompressed - candidateCompressed) / (referenceCompressed - input.compressedFloorBytes)
      : null
  const medianLatencyRatio = safeRatio(latency.candidate.medianMs, latency.reference.medianMs)
  const p95LatencyRatio = safeRatio(latency.candidate.p95Ms, latency.reference.p95Ms)
  const installedSizeGate = sizeReduction >= input.minimumSizeReduction ||
    (controllableSizeReduction !== null && controllableSizeReduction >= input.minimumSizeReduction)
  const compressedSizeGate = compressedSizeReduction === null ||
    compressedSizeReduction >= input.minimumCompressedSizeReduction ||
    (controllableCompressedSizeReduction !== null && controllableCompressedSizeReduction >= input.minimumCompressedSizeReduction)
  const sizeGate = installedSizeGate && compressedSizeGate
  const maximumLatencyRatio = input.maximumLatencyRatio ?? MAXIMUM_LATENCY_RATIO
  const latencyJitterAllowanceMs = input.latencyJitterAllowanceMs ?? LATENCY_JITTER_ALLOWANCE_MS
  const precisionGate = representation.contentIdentical &&
    representation.graphIdentical &&
    differingQueries.length === 0 &&
    candidateBenchmark.recallAt5 >= referenceBenchmark.recallAt5 &&
    candidateBenchmark.meanReciprocalRank >= referenceBenchmark.meanReciprocalRank
  const performanceGate =
    withinLatencyBudget(latency.candidate.medianMs, latency.reference.medianMs, maximumLatencyRatio, latencyJitterAllowanceMs) &&
    withinLatencyBudget(latency.candidate.p95Ms, latency.reference.p95Ms, maximumLatencyRatio, latencyJitterAllowanceMs)

  return {
    generatedAt: new Date().toISOString(),
    package: packageName,
    version,
    integrity: input.integrity,
    rounds,
    referenceFormat: input.reference.format,
    candidateFormat: input.candidate.format,
    baseline: {
      bytes: referenceBytes,
      compressedBytes: referenceCompressed,
      benchmark: referenceBenchmark,
      latency: latency.reference
    },
    compact: {
      bytes: candidateBytes,
      compressedBytes: candidateCompressed,
      benchmark: candidateBenchmark,
      latency: latency.candidate
    },
    improvement: {
      bytesSaved: referenceBytes - candidateBytes,
      sizeReduction,
      controllableSizeReduction,
      controllableCompressedSizeReduction,
      compressedBytesSaved: referenceCompressed === null || candidateCompressed === null
        ? null
        : referenceCompressed - candidateCompressed,
      compressedSizeReduction,
      medianLatencyRatio,
      p95LatencyRatio
    },
    precision: {
      contentIdentical: representation.contentIdentical,
      graphIdentical: representation.graphIdentical,
      rankingsIdentical: differingQueries.length === 0,
      differingQueries,
      recallNotWorse: candidateBenchmark.recallAt5 >= referenceBenchmark.recallAt5,
      meanReciprocalRankNotWorse: candidateBenchmark.meanReciprocalRank >= referenceBenchmark.meanReciprocalRank,
      trimmedByDesign: input.candidate.format === "trimmed" || input.reference.format === "trimmed"
    },
    gates: {
      installedSize: installedSizeGate,
      compressedSize: compressedSizeGate,
      size: sizeGate,
      precision: precisionGate,
      performance: performanceGate,
      passed: sizeGate && precisionGate && performanceGate,
      thresholds: {
        minimumSizeReduction: input.minimumSizeReduction,
        minimumCompressedSizeReduction: input.minimumCompressedSizeReduction,
        maximumLatencyRatio,
        latencyJitterAllowanceMs,
        sizeFloorBytes: input.sizeFloorBytes ?? null,
        compressedFloorBytes: input.compressedFloorBytes ?? null
      }    }
  }
}

export type ShrinkMeasurement = {
  referenceBytes: number
  referenceCompressedBytes: number | null
  candidateBytes: number
  candidateCompressedBytes: number | null
  sizeReduction: number
  controllableSizeReduction: number | null
  compressedSizeReduction: number | null
  controllableCompressedSizeReduction: number | null
  sizeGatePassed: boolean
}

export async function measureShrink(
  spec: string,
  referencePath: string,
  options: {
    candidateFormat?: BrainFormat
    minimumSizeReduction: number
    minimumCompressedSizeReduction: number
    sizeFloorBytes?: number
    compressedFloorBytes?: number | null
    onProgress?: (phase: string) => void
  }
): Promise<ShrinkMeasurement> {
  const candidateFormat = options.candidateFormat ?? "trimmed"
  const directory = await mkdtemp(join(tmpdir(), "apirova-shrink-"))
  const candidatePath = join(directory, `${candidateFormat}.db`)
  try {
    await buildBrain(spec, {
      output: candidatePath,
      format: candidateFormat,
      onProgress: (phase) => options.onProgress?.(`${candidateFormat}: ${phase}`)
    })
    const referenceBytes = statSync(referencePath).size
    const candidateBytes = statSync(candidatePath).size
    const referenceCompressed = compressedSize(referencePath)
    const candidateCompressed = compressedSize(candidatePath)
    const sizeReduction = referenceBytes === 0 ? 0 : 1 - candidateBytes / referenceBytes
    const controllableSizeReduction = options.sizeFloorBytes !== undefined && options.sizeFloorBytes < referenceBytes
      ? (referenceBytes - candidateBytes) / (referenceBytes - options.sizeFloorBytes)
      : null
    const compressedSizeReduction = referenceCompressed === null || candidateCompressed === null
      ? null
      : 1 - candidateCompressed / referenceCompressed
    const controllableCompressedSizeReduction =
      options.compressedFloorBytes != null &&
      referenceCompressed !== null &&
      candidateCompressed !== null &&
      options.compressedFloorBytes < referenceCompressed
        ? (referenceCompressed - candidateCompressed) / (referenceCompressed - options.compressedFloorBytes)
        : null
    return {
      referenceBytes,
      referenceCompressedBytes: referenceCompressed,
      candidateBytes,
      candidateCompressedBytes: candidateCompressed,
      sizeReduction,
      controllableSizeReduction,
      compressedSizeReduction,
      controllableCompressedSizeReduction,
      sizeGatePassed:
        (sizeReduction >= options.minimumSizeReduction ||
          (controllableSizeReduction !== null && controllableSizeReduction >= options.minimumSizeReduction)) &&
        (compressedSizeReduction === null ||
          compressedSizeReduction >= options.minimumCompressedSizeReduction ||
          (controllableCompressedSizeReduction !== null && controllableCompressedSizeReduction >= options.minimumCompressedSizeReduction))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function formatComparison(report: FormatComparison): string {
  const formats = report.referenceFormat && report.candidateFormat
    ? ` (${report.referenceFormat} → ${report.candidateFormat})`
    : ""
  const compressed = report.baseline.compressedBytes !== null && report.compact.compressedBytes !== null
    ? `\nCompressed: ${formatBytes(report.baseline.compressedBytes)} → ${formatBytes(report.compact.compressedBytes)} (${percent(report.improvement.compressedSizeReduction ?? 0)} smaller)`
    : ""
  const floorNote = report.improvement.controllableSizeReduction !== null && report.gates.thresholds.sizeFloorBytes !== null
    ? ` · ${percent(report.improvement.controllableSizeReduction)} of bytes above the ${formatBytes(report.gates.thresholds.sizeFloorBytes)} empty-schema floor`
    : ""
  const lines = [
    `Apirova format comparison · ${report.package}@${report.version}${formats}`,
    `Result: ${report.gates.passed ? "PASS" : "FAIL"}`,
    "",
    `Installed size: ${formatBytes(report.baseline.bytes)} → ${formatBytes(report.compact.bytes)} (${percent(report.improvement.sizeReduction)} smaller)${floorNote}${compressed}`,
    `Symbol content identical: ${yesNo(report.precision.contentIdentical)}${report.precision.trimmedByDesign ? " (shared columns)" : ""}`,
    `Graph content identical: ${yesNo(report.precision.graphIdentical)}${report.precision.trimmedByDesign ? " (triples)" : ""}`,
    `Ranked results identical: ${yesNo(report.precision.rankingsIdentical)}`,
    `Recall@5: ${(report.baseline.benchmark.recallAt5 * 100).toFixed(1)}% → ${(report.compact.benchmark.recallAt5 * 100).toFixed(1)}%`,
    `MRR: ${report.baseline.benchmark.meanReciprocalRank.toFixed(3)} → ${report.compact.benchmark.meanReciprocalRank.toFixed(3)}`,
    `Median latency: ${report.baseline.latency.medianMs.toFixed(2)} ms → ${report.compact.latency.medianMs.toFixed(2)} ms (${report.improvement.medianLatencyRatio.toFixed(3)}×)`,
    `p95 latency: ${report.baseline.latency.p95Ms.toFixed(2)} ms → ${report.compact.latency.p95Ms.toFixed(2)} ms (${report.improvement.p95LatencyRatio.toFixed(3)}×)`,
    `Samples: ${report.baseline.latency.samples} per format, interleaved`
  ]
  if (report.precision.trimmedByDesign) {
    lines.push("", "Note: source fragments and edge evidence are intentionally dropped by the trimmed format")
  }
  lines.push(
    "",
    `Gates: installed size ${yesNo(report.gates.installedSize)} · compressed size ${yesNo(report.gates.compressedSize)} · precision ${yesNo(report.gates.precision)} · performance ${yesNo(report.gates.performance)}`,
    `Thresholds: installed ≥${percent(report.gates.thresholds.minimumSizeReduction)} smaller; compressed ≥${percent(report.gates.thresholds.minimumCompressedSizeReduction)} smaller when zstd is available; identical content/rankings with no recall or MRR loss; latency ≤${report.gates.thresholds.maximumLatencyRatio.toFixed(2)}× reference and ≤+${report.gates.thresholds.latencyJitterAllowanceMs.toFixed(2)} ms`
  )
  return lines.join("\n")
}

function compareRepresentation(
  referencePath: string,
  referenceFormat: BrainFormat,
  candidatePath: string,
  candidateFormat: BrainFormat
): {
  contentIdentical: boolean
  graphIdentical: boolean
} {
  const reference = new Database(referencePath, { readonly: true, fileMustExist: true })
  const candidate = new Database(candidatePath, { readonly: true, fileMustExist: true })
  try {
    if (referenceFormat !== "trimmed" && candidateFormat !== "trimmed") {
      const referenceSymbols = (reference.prepare(`
        SELECT qualified_name, name, kind, module, signature, docs, source_path,
          line_start, line_end, source, is_public, is_deprecated, is_internal,
          category, example_count
        FROM symbols ORDER BY qualified_name
      `).all() as Array<Record<string, unknown>>).map((row) => symbolTuple(row, String(row.source)))
      const candidateSymbols = (candidate.prepare(`
        SELECT s.qualified_name, s.name, s.kind, s.module, s.signature, s.docs,
          s.source_path, s.line_start, s.line_end, s.source,
          s.is_public, s.is_deprecated, s.is_internal, s.category, s.example_count
        FROM symbols s ORDER BY s.qualified_name
      `).all() as Array<Record<string, unknown>>).map((row) => symbolTuple(row, String(row.source)))
      return {
        contentIdentical: JSON.stringify(referenceSymbols) === JSON.stringify(candidateSymbols),
        graphIdentical: JSON.stringify(loadFullEdges(reference, referenceFormat)) === JSON.stringify(loadFullEdges(candidate, candidateFormat))
      }
    }
    // Trimmed formats intentionally drop symbols.source and edges.evidence, so
    // parity is checked over every column both formats share, plus edge triples.
    return {
      contentIdentical: JSON.stringify(loadSharedSymbolTuples(reference, referenceFormat)) ===
        JSON.stringify(loadSharedSymbolTuples(candidate, candidateFormat)),
      graphIdentical: JSON.stringify(loadEdgeTriples(reference, referenceFormat)) ===
        JSON.stringify(loadEdgeTriples(candidate, candidateFormat))
    }
  } finally {
    reference.close()
    candidate.close()
  }
}

function loadFullEdges(db: Database.Database, format: BrainFormat): unknown {
  if (format === "baseline") {
    return db.prepare(`
      SELECT from_symbol, type, to_symbol, evidence
      FROM edges ORDER BY from_symbol, type, to_symbol
    `).all()
  }
  return db.prepare(`
    SELECT source.qualified_name AS from_symbol,
      CASE e.type
        WHEN 1 THEN 'accepts'
        WHEN 2 THEN 'returns'
        WHEN 3 THEN 'references'
        WHEN 4 THEN 'delegates_to'
        WHEN 5 THEN 're_exports'
      END AS type,
      target.qualified_name AS to_symbol,
      e.evidence
    FROM edges e
    JOIN nodes source ON source.id = e.from_id
    JOIN nodes target ON target.id = e.to_id
    ORDER BY from_symbol, type, to_symbol
  `).all()
}

function loadSharedSymbolTuples(db: Database.Database, format: BrainFormat): unknown[] {
  const rows = format === "trimmed"
    ? db.prepare(`
        SELECT n.qualified_name AS qualified_name, s.name, s.kind, s.module, s.signature,
          s.docs, s.source_path, s.line_start, s.line_end,
          s.is_public, s.is_deprecated, s.is_internal, s.category, s.example_count
        FROM symbols s
        JOIN nodes n ON n.id = s.id
        ORDER BY n.qualified_name
      `).all() as Array<Record<string, unknown>>
    : db.prepare(`
        SELECT qualified_name, name, kind, module, signature, docs, source_path,
          line_start, line_end, is_public, is_deprecated, is_internal, category, example_count
        FROM symbols ORDER BY qualified_name
      `).all() as Array<Record<string, unknown>>
  return rows.map((row) => [
    row.qualified_name,
    row.name,
    row.kind,
    row.module,
    row.signature,
    row.docs,
    row.source_path,
    row.line_start,
    row.line_end,
    row.is_public,
    row.is_deprecated,
    row.is_internal,
    row.category,
    row.example_count
  ])
}

function loadEdgeTriples(db: Database.Database, format: BrainFormat): unknown {
  if (format === "baseline") {
    return db.prepare(`
      SELECT from_symbol, type, to_symbol
      FROM edges ORDER BY from_symbol, type, to_symbol
    `).all()
  }
  return db.prepare(`
    SELECT source.qualified_name AS from_symbol,
      CASE e.type
        WHEN 1 THEN 'accepts'
        WHEN 2 THEN 'returns'
        WHEN 3 THEN 'references'
        WHEN 4 THEN 'delegates_to'
        WHEN 5 THEN 're_exports'
      END AS type,
      target.qualified_name AS to_symbol
    FROM edges e
    JOIN nodes source ON source.id = e.from_id
    JOIN nodes target ON target.id = e.to_id
    ORDER BY from_symbol, type, to_symbol
  `).all()
}

function symbolTuple(row: Record<string, unknown>, source: string): unknown[] {
  return [
    row.qualified_name,
    row.name,
    row.kind,
    row.module,
    row.signature,
    row.docs,
    row.source_path,
    row.line_start,
    row.line_end,
    source,
    row.is_public,
    row.is_deprecated,
    row.is_internal,
    row.category,
    row.example_count
  ]
}

function measureInterleavedLatency(
  packageName: string,
  cases: readonly BenchmarkCase[],
  version: string,
  referencePath: string,
  candidatePath: string,
  rounds: number
): {
  reference: { medianMs: number; p95Ms: number; samples: number }
  candidate: { medianMs: number; p95Ms: number; samples: number }
} {
  const samples = { reference: [] as number[], candidate: [] as number[] }
  for (let warmup = 0; warmup < 3; warmup++) {
    for (const testCase of cases) {
      queryBrain(packageName, testCase.question, { version, brainFile: referencePath, limit: 5, recordUsage: false })
      queryBrain(packageName, testCase.question, { version, brainFile: candidatePath, limit: 5, recordUsage: false })
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (const testCase of cases) {
      const order = round % 2 === 0
        ? [["reference", referencePath], ["candidate", candidatePath]] as const
        : [["candidate", candidatePath], ["reference", referencePath]] as const
      for (const [format, path] of order) {
        const response = queryBrain(packageName, testCase.question, { version, brainFile: path, limit: 5, recordUsage: false })
        samples[format].push(response.latencyMs)
      }
    }
  }
  return {
    reference: summarizeLatency(samples.reference),
    candidate: summarizeLatency(samples.candidate)
  }
}

function summarizeLatency(values: number[]): { medianMs: number; p95Ms: number; samples: number } {
  const sorted = [...values].sort((left, right) => left - right)
  return {
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    samples: sorted.length
  }
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0
}

export function compressedSize(path: string): number | null {
  try {
    return execFileSync("zstd", ["-q", "-c", "-3", path], { maxBuffer: 64 * 1024 * 1024 }).length
  } catch {
    return null
  }
}

export function specName(spec: string): string {
  const separator = spec.lastIndexOf("@")
  return separator > 0 ? spec.slice(0, separator) : spec
}

function safeRatio(value: number, baseline: number): number {
  return baseline === 0 ? 1 : value / baseline
}

/**
 * The latency budget combines relative (ratio) and absolute limits:
 * (jitter allowance) legs. Below RATIO_FLOOR_MS of reference latency the
 * relative leg is inside scheduler noise (0.10 × 2 ms = 0.2 ms), so the
 * absolute allowance alone governs: the same reasoning that motivates the
 * dual limit, extended down to the sub-millisecond corpus brains.
 */
export function withinLatencyBudget(value: number, baseline: number, maximumRatio: number, jitterAllowanceMs: number): boolean {
  const RATIO_FLOOR_MS = 2
  const ratioLeg = baseline < RATIO_FLOOR_MS ? Infinity : baseline * maximumRatio
  return value <= ratioLeg && value <= baseline + jitterAllowanceMs
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no"
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`
}
