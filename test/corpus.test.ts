import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { EFFECT_CASES, runBenchmark, type BenchmarkCase } from "../src/benchmark.js"
import { CORPUS_REPORT_DIR, caseFilePath, corpusCaseFile, hasCorpusCases, loadCorpus } from "../src/benchmark/corpus.js"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"

function packageEntry(rank: number, name?: string): Record<string, unknown> {
  return {
    name: name ?? `fixture-pkg-${rank}`,
    version: "1.0.0",
    integrity: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    popularityRank: rank,
    weeklyDownloads: 1_000_000 - rank,
    tsSurfaceBytes: 4096 * rank,
    notes: ""
  }
}

function manifestJson(packages: unknown[], rejected: unknown[] = []): string {
  return JSON.stringify({ generatedAt: "2026-09-04T00:00:00.000Z", source: "fixture", packages, rejected })
}

function caseJson(packageName: string, cases: unknown[]): string {
  return JSON.stringify({ package: packageName, notes: "fixture", cases })
}

it("loads bundled benchmark data outside the repository working directory", () => {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmpdir())
  try {
    const corpus = loadCorpus()
    expect(corpus.packages).toHaveLength(10)
    for (const entry of corpus.packages) expect(corpusCaseFile(entry.name).length).toBeGreaterThan(0)
  } finally {
    cwd.mockRestore()
  }
})

describe("corpus manifest loader", () => {
  const directory = mkdtempSync(join(tmpdir(), "apirova-corpus-"))
  const valid = join(directory, "valid", "corpus.json")
  const options = { manifestPath: valid }

  beforeAll(() => {
    mkdirSync(join(directory, "valid"), { recursive: true })
    writeFileSync(valid, manifestJson(Array.from({ length: 10 }, (_, index) => packageEntry(index + 1))))
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it("exposes the corpus report directory contract", () => {
    expect(CORPUS_REPORT_DIR).toBe("docs/benchmarks/corpus")
  })

  it("fails with the path when the manifest is missing", () => {
    const missing = join(directory, "absent", "corpus.json")
    expect(() => loadCorpus({ manifestPath: missing })).toThrowError(/Corpus manifest not found at .*corpus\.json/)
  })

  it("reports invalid JSON with the path", () => {
    const path = join(directory, "broken", "corpus.json")
    mkdirSync(join(directory, "broken"), { recursive: true })
    writeFileSync(path, "{ not json")
    expect(() => loadCorpus({ manifestPath: path })).toThrowError(/not valid JSON/)
  })

  it("rejects manifests without exactly 10 packages", () => {
    const path = join(directory, "short", "corpus.json")
    mkdirSync(join(directory, "short"), { recursive: true })
    writeFileSync(path, manifestJson(Array.from({ length: 9 }, (_, index) => packageEntry(index + 1))))
    expect(() => loadCorpus({ manifestPath: path })).toThrowError(/invalid shape.*packages/s)
  })

  it("rejects packages that are not sorted by rank", () => {
    const path = join(directory, "unsorted", "corpus.json")
    mkdirSync(join(directory, "unsorted"), { recursive: true })
    const packages = Array.from({ length: 10 }, (_, index) => packageEntry(index + 1))
    const swapped = [packages[1], packages[0], ...packages.slice(2)]
    writeFileSync(path, manifestJson(swapped))
    expect(() => loadCorpus({ manifestPath: path })).toThrowError(/sorted by ascending popularityRank/)
  })

  it("rejects entries with missing or malformed fields", () => {
    const path = join(directory, "malformed", "corpus.json")
    mkdirSync(join(directory, "malformed"), { recursive: true })
    const [first, ...rest] = Array.from({ length: 10 }, (_, index) => packageEntry(index + 1))
    writeFileSync(path, manifestJson([{ ...first, integrity: 42 }, ...rest]))
    expect(() => loadCorpus({ manifestPath: path })).toThrowError(/integrity/)
  })

  it("loads a valid manifest with packages and rejected entries", () => {
    const path = join(directory, "full", "corpus.json")
    mkdirSync(join(directory, "full"), { recursive: true })
    writeFileSync(path, manifestJson(Array.from({ length: 10 }, (_, index) => packageEntry(index + 1)), [
      { name: "left-pad", popularityRank: 1, reason: "deprecated in favor of built-ins" }
    ]))
    const corpus = loadCorpus({ manifestPath: path })
    expect(corpus.packages).toHaveLength(10)
    expect(corpus.packages[0]).toMatchObject({ name: "fixture-pkg-1", popularityRank: 1 })
    expect(corpus.packages.map((entry) => entry.popularityRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(corpus.rejected).toEqual([{ name: "left-pad", popularityRank: 1, reason: "deprecated in favor of built-ins" }])
  })
})

describe("corpus case files", () => {
  const directory = mkdtempSync(join(tmpdir(), "apirova-cases-"))
  const casesDirectory = join(directory, "cases")
  const options = { casesDirectory }

  beforeAll(() => {
    mkdirSync(casesDirectory, { recursive: true })
    writeFileSync(join(casesDirectory, "axios.json"), caseJson("axios", [
      { question: "how do I make a GET request", expected: ["Axios.request", "axios.get"] }
    ]))
    writeFileSync(join(casesDirectory, "hollow.json"), caseJson("hollow", []))
    writeFileSync(join(casesDirectory, "silent.json"), caseJson("silent", [{ question: "", expected: ["X"] }]))
    writeFileSync(join(casesDirectory, "aimless.json"), caseJson("aimless", [{ question: "anything", expected: [] }]))
    writeFileSync(join(casesDirectory, "imposter.json"), caseJson("other", [{ question: "anything", expected: ["X"] }]))
  })

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it("keeps effect on the built-in suite without reading a file", () => {
    expect(hasCorpusCases("effect")).toBe(true)
    const cases = corpusCaseFile("effect", { casesDirectory: join(directory, "does-not-exist") })
    expect(cases).toHaveLength(EFFECT_CASES.length)
    expect(cases[0]?.question).toBe(EFFECT_CASES[0].question)
  })

  it("loads and validates a package case file", () => {
    expect(hasCorpusCases("axios", options)).toBe(true)
    const cases = corpusCaseFile("axios", options)
    expect(cases).toEqual([{ question: "how do I make a GET request", expected: ["Axios.request", "axios.get"] }])
  })

  it("lists the missing case file path for unauthored packages", () => {
    expect(hasCorpusCases("left-pad", options)).toBe(false)
    expect(() => corpusCaseFile("left-pad", options)).toThrowError(/No benchmark cases for left-pad.*left-pad\.json/s)
  })

  it("rejects an empty case list", () => {
    expect(() => corpusCaseFile("hollow", options)).toThrowError(/at least one case/)
  })

  it("rejects cases with an empty question", () => {
    expect(() => corpusCaseFile("silent", options)).toThrowError(/question must be a non-empty string/)
  })

  it("rejects cases without expected symbols", () => {
    expect(() => corpusCaseFile("aimless", options)).toThrowError(/expected must contain at least one symbol/)
  })

  it("rejects a case file declaring a different package", () => {
    expect(() => corpusCaseFile("imposter", options)).toThrowError(/declares package "other"/)
  })

  it("resolves default case paths relative to the working directory", () => {
    expect(caseFilePath("axios")).toMatch(/src[\\/]benchmark[\\/]cases[\\/]axios\.json$/)
  })
})

describe("runBenchmark aggregate math", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "apirova-runbench-"))
  const previousHome = process.env.APIROVA_HOME
  const packageName = "corpusbench"

  beforeAll(() => {
    process.env.APIROVA_HOME = temporaryHome
    seedBrain()
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.APIROVA_HOME
    else process.env.APIROVA_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  it("computes pass rate, recall, and MRR from per-case outcomes", () => {
    const cases: BenchmarkCase[] = [
      { question: "retry with exponential delay", expected: ["Effect.retry", "Schedule.exponential"] },
      { question: "zabbit quarble flibbertigibbet", expected: ["Totally.Missing"] }
    ]
    const report = runBenchmark(packageName, cases, { version: "1.0.0" })
    expect(report.package).toBe(packageName)
    expect(report.version).toBe("1.0.0")
    expect(report.cases).toBe(2)
    expect(report.passedCases).toBe(1)
    expect(report.taskPassRate).toBeCloseTo(0.5, 10)
    expect(report.expectedSymbols).toBe(3)
    expect(report.foundSymbols).toBe(2)
    expect(report.recallAt5).toBeCloseTo(2 / 3, 10)
    expect(report.meanReciprocalRank).toBeCloseTo(0.5, 10)
    expect(report.results).toHaveLength(2)
    expect(report.results[0]?.passed).toBe(true)
    expect(report.results[0]?.returned).toContain("Effect.retry")
    expect(report.results[1]?.passed).toBe(false)
    expect(report.results[1]?.found).toEqual([])
    expect(report.averageLatencyMs).toBeGreaterThanOrEqual(0)
    expect(report.estimatedResultTokens).toBeGreaterThan(0)
  })

  it("returns finite zeroed aggregates when there are no cases", () => {
    const report = runBenchmark(packageName, [], { version: "1.0.0" })
    expect(report.cases).toBe(0)
    expect(report.taskPassRate).toBe(0)
    expect(report.recallAt5).toBe(0)
    expect(report.meanReciprocalRank).toBe(0)
    expect(Number.isFinite(report.averageLatencyMs)).toBe(true)
  })

  function seedBrain(): void {
    const path = brainPath(packageName, "1.0.0")
    mkdirSync(dirname(path), { recursive: true })
    const db = createBrainDatabase(path, "baseline")
    const insert = db.prepare(`
      INSERT INTO symbols (
        qualified_name, name, kind, module, signature, docs, source_path,
        line_start, line_end, source, is_public, is_deprecated, is_internal,
        category, example_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const search = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
    const rows = [
      ["Effect.retry", "retry", "const", "Effect", "retry(policy: Schedule)", "Retries an operation using a schedule, including exponential delays.", "src/Effect.ts", 30, 40, "", 1, 0, 0, "Error handling", 2],
      ["Schedule.exponential", "exponential", "const", "Schedule", "exponential(base: Duration)", "Creates exponentially increasing retry delays.", "src/Schedule.ts", 50, 60, "", 1, 0, 0, "Constructors", 1]
    ] as const
    for (const row of rows) {
      const result = insert.run(...row)
      search.run(result.lastInsertRowid, `${row[0]} ${row[1]}`, `${row[5]} ${row[4]}`, "public " + row[3])
    }
    db.close()
  }
})
