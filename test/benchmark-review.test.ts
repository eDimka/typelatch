import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type Database from "better-sqlite3"
import type { BenchmarkCase } from "../src/benchmark.js"
import { CORPUS_PACKAGE_COUNT, corpusCaseFile, loadCorpus } from "../src/benchmark/corpus.js"
import { createBrainDatabase, openBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"

type MissingReport = Array<{ question: string; missing: string[] }>

// The scorer compares engine output against `expected` using the exact
// qualified_name string, so this check is deliberately exact-match (no
// case-folding, no bare-name fallback).
function missingExpectedSymbols(db: Database.Database, cases: BenchmarkCase[]): MissingReport {
  const known = new Set(
    (db.prepare("SELECT qualified_name FROM symbols").all() as Array<{ qualified_name: string }>)
      .map((row) => row.qualified_name)
  )
  const reports: MissingReport = []
  for (const item of cases) {
    const missing = item.expected.filter((symbol) => !known.has(symbol))
    if (missing.length > 0) reports.push({ question: item.question, missing })
  }
  return reports
}

describe("expected symbols must exist in the brain (fixture)", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "typelatch-expected-"))
  const packageName = "fixturepkg"
  const version = "1.0.0"
  const previousHome = process.env.TYPELATCH_HOME

  beforeAll(() => {
    process.env.TYPELATCH_HOME = temporaryHome
    mkdirSync(dirname(brainPath(packageName, version)), { recursive: true })
    const db = createBrainDatabase(brainPath(packageName, version), "baseline")
    const insert = db.prepare(`
      INSERT INTO symbols (
        qualified_name, name, kind, module, signature, docs, source_path,
        line_start, line_end, source, is_public, is_deprecated, is_internal,
        category, example_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run("esm.Cache", "Cache", "class", "esm", "class Cache", "", "index.d.ts", 1, 2, "", 1, 0, 0, null, 0)
    insert.run("esm.max", "max", "const", "esm", "export const max: number", "", "index.d.ts", 3, 3, "", 1, 0, 0, null, 0)
    db.close()
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.TYPELATCH_HOME
    else process.env.TYPELATCH_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  it("accepts a case file whose expectations all resolve to real symbols", () => {
    const db = openBrainDatabase(brainPath(packageName, version))
    try {
      const cases: BenchmarkCase[] = [
        { question: "create a cache", expected: ["esm.Cache"] },
        { question: "read the size limit", expected: ["esm.Cache", "esm.max"] }
      ]
      expect(missingExpectedSymbols(db, cases)).toEqual([])
    } finally {
      db.close()
    }
  })

  it("flags an expectation that names a symbol absent from the brain", () => {
    const db = openBrainDatabase(brainPath(packageName, version))
    try {
      const cases: BenchmarkCase[] = [
        { question: "create a cache", expected: ["esm.Cache"] },
        { question: "purge entries", expected: ["esm.CacheOptions.purge"] }
      ]
      expect(missingExpectedSymbols(db, cases)).toEqual([
        { question: "purge entries", missing: ["esm.CacheOptions.purge"] }
      ])
    } finally {
      db.close()
    }
  })

  it("does not case-fold or fall back to bare names when matching", () => {
    const db = openBrainDatabase(brainPath(packageName, version))
    try {
      expect(missingExpectedSymbols(db, [{ question: "q", expected: ["esm.cache"] }])).toEqual([
        { question: "q", missing: ["esm.cache"] }
      ])
      expect(missingExpectedSymbols(db, [{ question: "q", expected: ["Cache"] }])).toEqual([
        { question: "q", missing: ["Cache"] }
      ])
    } finally {
      db.close()
    }
  })
})

describe("checked-in corpus is internally consistent", () => {
  // Needs no brains and no network: manifest + case files only.
  it("gives every corpus package a loadable case file and no stray case files", () => {
    const corpus = loadCorpus()
    expect(corpus.packages).toHaveLength(CORPUS_PACKAGE_COUNT)
    const packages = new Set(corpus.packages.map((entry) => entry.name))
    for (const name of packages) {
      const cases = corpusCaseFile(name)
      expect(cases.length).toBeGreaterThan(0)
      for (const item of cases) {
        expect(item.expected.length).toBeGreaterThan(0)
      }
    }
    const caseFiles = readdirSync("src/benchmark/cases").filter((file) => file.endsWith(".json"))
    expect(new Set(caseFiles)).toEqual(new Set([...packages].map((name) => `${name}.json`)))
  })
})

const realCorpus = (() => {
  try {
    const corpus = loadCorpus()
    return { corpus, brains: corpus.packages.map((entry) => brainPath(entry.name, entry.version)) }
  } catch {
    return null
  }
})()

describe.skipIf(realCorpus === null || realCorpus.brains.some((path) => !existsSync(path)))(
  "checked-in case files resolve against installed brains",
  () => {
    it("finds every expected symbol as an exact qualified_name in its package brain", () => {
      if (realCorpus === null) throw new Error("unreachable")
      for (const entry of realCorpus.corpus.packages) {
        const path = brainPath(entry.name, entry.version)
        if (!existsSync(path)) continue
        const db = openBrainDatabase(path)
        try {
          const cases = corpusCaseFile(entry.name)
          const problems = missingExpectedSymbols(db, cases)
          expect(problems, `${entry.name}@${entry.version} case expectations`).toEqual([])
        } finally {
          db.close()
        }
      }
    })
  }
)
