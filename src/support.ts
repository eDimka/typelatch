import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import { loadCorpus } from "./benchmark/corpus.js"
import { buildBrain, GENERATOR_VERSION } from "./indexer.js"
import { brainPath } from "./paths.js"
import { openBrainDatabase } from "./database.js"
import { sha256 } from "./workspace/project.js"
import { workspaceContextAsync } from "./workspace/runtime.js"
import { validateWorkspace } from "./workspace/validate.js"

const taskSchema = z.object({
  id: z.string().min(1), question: z.string().min(1), symbol: z.string().min(1),
  cursorToken: z.string().min(1), expectedSymbols: z.array(z.string().min(1)).min(1)
}).strict()
export const supportSchema = z.object({
  schemaVersion: z.literal(1), config: z.string().min(1),
  packages: z.array(z.object({
    name: z.string().min(1), version: z.string().min(1), integrity: z.string().min(1), file: z.string().min(1),
    importSpecifier: z.string().min(1), testCommand: z.array(z.string()).min(1),
    tasks: z.array(taskSchema).min(2)
  }).strict()).min(10)
}).strict()

export function validateSupportManifest(value: unknown) {
  const manifest = supportSchema.parse(value)
  const corpus = loadCorpus()
  const identities = manifest.packages.map(p => `${p.name}@${p.version}`)
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate support package version")
  for (const pin of corpus.packages) {
    const entry = manifest.packages.find(p => p.name === pin.name && p.version === pin.version)
    if (!entry || entry.integrity !== pin.integrity) throw new Error(`Corpus identity mismatch: ${pin.name}`)
  }
  const ids = manifest.packages.flatMap(p => p.tasks.map(t => t.id))
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate support task IDs")
  return manifest
}


export async function runSupport(manifestFile: string, reportFile: string, progress?: (message: string) => void) {
  const raw = readFileSync(manifestFile, "utf8")
  const manifest = validateSupportManifest(JSON.parse(raw))
  const root = dirname(resolve(manifestFile))
  const config = resolve(root, manifest.config)
  type Live = Awaited<ReturnType<typeof workspaceContextAsync>>
  type Validation = Awaited<ReturnType<typeof validateWorkspace>>
  const packages: Array<{
    name: string; version: string; success: boolean; error: string | null; source: string | null;
    tasks: Array<{ id: string; request: Parameters<typeof workspaceContextAsync>[0]; support: boolean; retrievalHit: boolean; retrievedCandidateResolved: boolean; navigationMatched: boolean; evidence: Live }>;
    validation: Validation | null;
    controls: null | { wrongVersionRejected: boolean; missingApiRejected: boolean; invalidTypeRejected: boolean; failingAssertionRejected: boolean;
      wrongVersion: Live; missingApi: Live; invalidType: Validation; failingAssertion: Validation }
  }> = []
  const report = () => ({
    schemaVersion: 1, kind: "development-integration", adapter: "typescript-language-service-direct",
    generatedAt: new Date().toISOString(), manifestHash: sha256(raw), manifest,
    complete: packages.length === manifest.packages.length, passed: packages.length === manifest.packages.length && packages.every(p => p.success),
    navigationPassed: packages.length === manifest.packages.length && packages.every(p => p.tasks.length >= 2 && p.tasks.every(t => t.support && t.navigationMatched) && p.validation?.success && p.controls?.wrongVersionRejected && p.controls.missingApiRejected && p.controls.invalidTypeRejected && p.controls.failingAssertionRejected),
    totals: { packages: packages.length, packagesPassed: packages.filter(p => p.success).length,
      tasks: packages.reduce((n,p) => n+p.tasks.length,0),
      supportPassed: packages.flatMap(p=>p.tasks).filter(t=>t.support).length,
      navigationMatches: packages.flatMap(p=>p.tasks).filter(t=>t.navigationMatched).length,
      retrievalHits: packages.flatMap(p=>p.tasks).filter(t=>t.retrievalHit).length,
      retrievedCandidatesResolved: packages.flatMap(p=>p.tasks).filter(t=>t.retrievedCandidateResolved).length },
    limitations: ["Authored executable integration fixtures, not held-out model-generated solutions", "Direct TypeScript language service; no LSP wire protocol tested", "Registry integrity pin does not prove installed artifact equivalence", "Runtime assertions cover only the supplied scenarios"], packages
  })
  const save = () => {
    mkdirSync(dirname(resolve(reportFile)), { recursive: true })
    const temporary = `${reportFile}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(report(), null, 2)+"\n")
    renameSync(temporary, reportFile)
  }
  for (const entry of manifest.packages) {
    progress?.(`${entry.name}@${entry.version}`)
    const row: typeof packages[number] = { name: entry.name, version: entry.version, success: false, error: null, source: null, tasks: [], validation: null, controls: null }
    try {
      const installed = brainPath(entry.name, entry.version)
      let needsBuild = !existsSync(installed)
      if (!needsBuild) {
        const db = openBrainDatabase(installed)
        try { needsBuild = (db.prepare("SELECT value FROM metadata WHERE key = 'generator'").get() as {value: string} | undefined)?.value !== GENERATOR_VERSION }
        finally { db.close() }
      }
      if (needsBuild) await buildBrain(`${entry.name}@${entry.version}`, { format: "trimmed", ...(progress ? { onProgress: progress } : {}) })
      const source = readFileSync(resolve(root, entry.file), "utf8")
      row.source = source
      const base = { config, file: entry.file, importSpecifier: entry.importSpecifier, expectedVersion: entry.version, timeoutMs: 30_000 }
      for (const task of entry.tasks) {
        const position = source.indexOf(task.cursorToken)
        if (position < 0 || source.indexOf(task.cursorToken, position + 1) >= 0) throw new Error(`Cursor token must occur exactly once: ${task.id}`)
        const request = { ...base, position: position + 1, symbol: task.symbol, question: task.question }
        progress?.(`${entry.name} / ${task.id}: ${task.question}`)
        const live = await workspaceContextAsync(request)
        const expectedResults = live.brain?.results.filter(r => task.expectedSymbols.includes(r.symbol) || task.expectedSymbols.includes(r.symbol.startsWith(`${r.module}.`) ? r.symbol.slice(r.module.length + 1) : r.symbol)) ?? []
        const retrievalHit = expectedResults.length > 0
        const retrievedCandidateResolved = live.candidates.some(c => expectedResults.some(r => r.symbol === c.symbol) && c.workspaceExport !== null)
        const support = live.dependency?.name === entry.name && live.checks.versionMatch.status === "pass" &&
          live.checks.resolved.status === "pass" && live.checks.retrieved.status === "pass" && live.brainProvenance?.integrity === entry.integrity &&
          !!live.hover && live.definitions.length > 0 && live.api !== null && live.checks.typechecked.status === "not-run" && live.checks.tested.status === "not-run" &&
          live.checks.artifactMatch.status === "unknown"
        const navigationMatched = live.navigation.status === "pass" && !!live.navigation.brain?.results.some(r => task.expectedSymbols.includes(r.symbol))
        row.tasks.push({ id: task.id, request, support, retrievalHit, retrievedCandidateResolved, navigationMatched, evidence: live })
      }
      const testCommand = entry.testCommand.map((value, i) => i === 0 && value === "node" ? process.execPath : value)
      const validationRequest = { config, testCommand, timeoutMs: 60_000, record: false, runtimeInputs: ["node_modules"] }
      row.validation = await validateWorkspace(validationRequest)
      const wrongVersion = await workspaceContextAsync({ ...base, expectedVersion: `${Number(entry.version.split('.')[0]) + 1}.0.0`, question: entry.tasks[0]!.question })
      const missingApi = await workspaceContextAsync({ ...base, symbol: "__typelatch_nonexistent_export__" })
      const invalidType = await validateWorkspace({ config, overlays: [{ file: entry.file, text: source+'\nconst __typelatch_type_error__: never = 42;\n' }], timeoutMs: 30_000, record: false })
      const failingAssertion = await validateWorkspace({ ...validationRequest, testCommand: [process.execPath, "--input-type=module", "-e", "import assert from 'node:assert/strict'; assert.equal(1, 2)"] })
      row.controls = {
        wrongVersionRejected: wrongVersion.checks.versionMatch.status === "fail" && wrongVersion.brain === null && wrongVersion.checks.retrieved.status === "not-run",
        missingApiRejected: missingApi.api === null,
        invalidTypeRejected: !invalidType.success && invalidType.checks.typechecked.status === "fail",
        failingAssertionRejected: !failingAssertion.success && failingAssertion.checks.typechecked.status === "pass" && failingAssertion.checks.tested.status === "fail",
        wrongVersion, missingApi, invalidType, failingAssertion
      }
      row.success = row.tasks.every(t => t.support) && row.tasks.every(t => t.retrievedCandidateResolved) && row.validation.success && row.controls.wrongVersionRejected && row.controls.missingApiRejected && row.controls.invalidTypeRejected && row.controls.failingAssertionRejected
    } catch (error) { row.error = error instanceof Error ? error.message : String(error) }
    packages.push(row)
    save()
    progress?.(`${entry.name}@${entry.version}: ${row.success ? "PASS" : "FAIL"}${row.error ? `: ${row.error}` : ""}`)
  }
  return report()
}
