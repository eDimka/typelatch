import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { EFFECT_CASES, type BenchmarkCase } from "../benchmark.js"

export const CORPUS_REPORT_DIR = "docs/benchmarks/corpus"
export const CORPUS_PACKAGE_COUNT = 10

export type CorpusPackage = {
  name: string
  version: string
  integrity: string
  popularityRank: number
  weeklyDownloads: number
  tsSurfaceBytes: number
  notes: string
}

export type CorpusRejectedEntry = {
  name: string
  popularityRank: number
  reason: string
}

export type CorpusManifest = {
  generatedAt: string
  source: string
  packages: CorpusPackage[]
  rejected: CorpusRejectedEntry[]
}

export type CorpusOptions = {
  manifestPath?: string
  casesDirectory?: string
}

const packageEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  integrity: z.string().min(1),
  popularityRank: z.number().int().positive(),
  weeklyDownloads: z.number().int().nonnegative(),
  tsSurfaceBytes: z.number().int().nonnegative(),
  notes: z.string()
})

const rejectedEntrySchema = z.object({
  name: z.string().min(1),
  popularityRank: z.number().int().positive(),
  reason: z.string().min(1)
})

const manifestSchema = z.object({
  generatedAt: z.string().min(1),
  source: z.string().min(1),
  packages: z.array(packageEntrySchema).length(CORPUS_PACKAGE_COUNT),
  rejected: z.array(rejectedEntrySchema)
})

const retrievalCaseSchema = z.object({
  question: z.string().min(1, "question must be a non-empty string"),
  expected: z
    .array(z.string().min(1, "expected symbols must be non-empty strings"))
    .min(1, "expected must contain at least one symbol")
})

const caseFileSchema = z.object({
  package: z.string().min(1),
  notes: z.string().optional(),
  cases: z.array(retrievalCaseSchema).min(1, "cases must contain at least one case")
})

export function defaultManifestPath(): string {
  return fileURLToPath(new URL("./corpus.json", import.meta.url))
}

export function manifestPath(options?: CorpusOptions): string {
  return resolve(options?.manifestPath ?? defaultManifestPath())
}

export function caseFilePath(packageName: string, options?: CorpusOptions): string {
  return resolve(options?.casesDirectory ?? fileURLToPath(new URL("./cases/", import.meta.url)), `${packageName}.json`)
}

export function loadCorpus(options?: CorpusOptions): CorpusManifest {
  const path = manifestPath(options)
  if (!existsSync(path)) {
    throw new Error(
      `Corpus manifest not found at ${path}. Reinstall the package or pass an explicit manifest path.`
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Corpus manifest at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Corpus manifest at ${path} has an invalid shape: ${describeIssues(parsed.error.issues)}`)
  }
  const data = parsed.data
  const problems: string[] = []
  const seenNames = new Set<string>()
  for (const entry of data.packages) {
    if (seenNames.has(entry.name)) problems.push(`duplicate package name "${entry.name}"`)
    seenNames.add(entry.name)
  }
  for (let index = 1; index < data.packages.length; index++) {
    const previous = data.packages[index - 1]
    const current = data.packages[index]
    if (previous && current && current.popularityRank <= previous.popularityRank) {
      problems.push(
        `packages must be sorted by ascending popularityRank (${current.name} rank ${current.popularityRank} follows ${previous.name} rank ${previous.popularityRank})`
      )
    }
  }
  const rejectedNames = new Set<string>()
  for (const entry of data.rejected) {
    if (rejectedNames.has(entry.name)) problems.push(`duplicate rejected package name "${entry.name}"`)
    rejectedNames.add(entry.name)
  }
  const shadowed = data.packages.filter((entry) => rejectedNames.has(entry.name)).map((entry) => entry.name)
  if (shadowed.length > 0) problems.push(`packages also listed as rejected: ${shadowed.join(", ")}`)
  if (problems.length > 0) throw new Error(`Corpus manifest at ${path} is invalid: ${problems.join("; ")}`)
  return data
}

export function hasCorpusCases(packageName: string, options?: CorpusOptions): boolean {
  if (packageName === "effect") return true
  return existsSync(caseFilePath(packageName, options))
}

export function corpusCaseFile(packageName: string, options?: CorpusOptions): readonly BenchmarkCase[] {
  if (packageName === "effect") return EFFECT_CASES
  const path = caseFilePath(packageName, options)
  if (!existsSync(path)) {
    throw new Error(
      `No benchmark cases for ${packageName}: expected case file at ${path} (not authored yet). Create it with {"package":"${packageName}","notes":"...","cases":[{"question":"...","expected":["Symbol.one"]}]}.`
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new Error(`Benchmark case file at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = caseFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Benchmark case file at ${path} has an invalid shape: ${describeIssues(parsed.error.issues)}`)
  }
  if (parsed.data.package !== packageName) {
    throw new Error(`Benchmark case file at ${path} declares package "${parsed.data.package}" but was loaded for "${packageName}"`)
  }
  return parsed.data.cases
}

function describeIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".")}: ${issue.message}`)
    .join("; ")
}
