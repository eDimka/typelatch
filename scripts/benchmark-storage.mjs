import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { prepareBaseline } from './competitive-baseline.mjs'

const arguments_ = process.argv.slice(2)
assert.ok(arguments_.length === 0 || arguments_.length === 2 && arguments_[0] === '--baseline-ref', 'Expected optional --baseline-ref <git-commit>')
const directory = resolve('artifacts/competitive/storage')
const digest = value => createHash('sha256').update(value).digest('hex')
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
const previousHome = process.env.TYPELATCH_HOME
mkdirSync(directory, { recursive: true })

const baselineBuild = prepareBaseline(directory, arguments_[1])
const baselineRef = baselineBuild.ref
const fromGit = baselineBuild.readFile
const corpus = baselineBuild.readTree(['src', 'test', 'README.md', 'docs/USAGE.md', 'docs/ARCHITECTURE.md'])
save(join(directory, 'corpus.json'), corpus)
const fixtures = [
  { name: 'small', files: [{ path: 'src/request.ts', text: 'export function validateRequest(value: unknown) { return value !== null }\n' }], questions: ['validateRequest', 'request', 'missingNeedle'] },
  { name: 'repository', files: corpus, questions: ['validateWorkspace', 'verifyIntegrity', 'recordOutcome', 'runCommand', 'registry integrity tarball', 'timeout command output', 'same size writes invalidate', 'cursor definitions references', 'missingNeedle'] },
  { name: 'generated', files: Array.from({ length: 80 }, (_, i) => ({ path: `src/service${i}.ts`, text: Array.from({ length: 40 }, (_, j) => `/** Validate incoming request ${j} and preserve its payload before dispatch. */\nexport function validateRequest${i}_${j}(payload: string): string {\n  return payload.trim()\n}\n`).join('\n') })), questions: ['validateRequest42_12', 'validate incoming payload', 'service42.ts', 'missingNeedle'] }
]

async function measure(modulePath, label) {
  const { searchWorkspaceIndex } = await import(pathToFileURL(modulePath).href)
  const home = join(directory, `cache-${label}`)
  rmSync(home, { recursive: true, force: true })
  process.env.TYPELATCH_HOME = home
  const rows = []
  for (const fixture of fixtures) {
    const root = join(directory, 'fixtures', fixture.name)
    const files = fixture.files.map(file => ({ ...file, path: join(root, file.path), hash: digest(file.text), searchable: true }))
    const requests = []
    let indexPath
    for (const question of fixture.questions) {
      const started = performance.now()
      const cold = searchWorkspaceIndex(root, files, question, new AbortController().signal)
      const firstMs = performance.now() - started
      const warmStarted = performance.now()
      const warm = searchWorkspaceIndex(root, files, question, new AbortController().signal)
      const warmMs = performance.now() - warmStarted
      assert.deepEqual(warm.candidates, cold.candidates)
      assert.equal(warm.index.updatedFiles, 0)
      indexPath = warm.index.path
      requests.push({ question, firstMs, warmMs, updatedFiles: cold.index.updatedFiles, candidates: warm.candidates, candidateLimitReached: warm.candidateLimitReached, truncated: warm.truncated })
    }
    const info = statSync(indexPath)
    // Observe files before the read-only inspection can itself create WAL sidecars.
    const sidecars = ['-wal', '-shm'].map(suffix => { try { const entry = statSync(indexPath + suffix); return { bytes: entry.size, allocatedBytes: entry.blocks * 512 } } catch (error) { if (error.code !== 'ENOENT') throw error; return { bytes: 0, allocatedBytes: 0 } } })
    const db = new Database(indexPath, { readonly: true })
    const sqlite = db.prepare('SELECT sqlite_version() AS version').get().version
    const pages = db.pragma('page_count', { simple: true })
    const freePages = db.pragma('freelist_count', { simple: true })
    db.close()
    rows.push({ name: fixture.name, files: files.length, sourceBytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0), fixtureSha256: digest(JSON.stringify(fixture.files)), bytes: info.size + sidecars.reduce((sum, entry) => sum + entry.bytes, 0), allocatedBytes: info.blocks * 512 + sidecars.reduce((sum, entry) => sum + entry.allocatedBytes, 0), sidecarBytes: sidecars.map(entry => entry.bytes), pages, freePages, sqlite, requests })
  }
  return { label, generatedAt: new Date().toISOString(), node: process.version, moduleSha256: digest(readFileSync(modulePath)), rows }
}

try {
    const baseline = await measure(join(directory, 'baseline-dist/workspace/search-index.js'), 'baseline-rerun')
    const after = await measure(resolve('dist/workspace/search-index.js'), 'after')
    const rows = after.rows.map((row, index) => {
      const before = baseline.rows[index]
      assert.equal(row.fixtureSha256, before.fixtureSha256)
      for (let i = 0; i < row.requests.length; i++) {
        for (const field of ['candidates', 'candidateLimitReached', 'truncated', 'updatedFiles']) assert.deepEqual(row.requests[i][field], before.requests[i][field], `${row.name}: ${field}`)
      }
      return { name: row.name, files: row.files, sourceBytes: row.sourceBytes, fixtureSha256: row.fixtureSha256, beforeBytes: before.bytes, afterBytes: row.bytes, savedBytes: before.bytes - row.bytes, reductionPercent: Math.round(10000 * (before.bytes - row.bytes) / before.bytes) / 100, beforeAllocatedBytes: before.allocatedBytes, afterAllocatedBytes: row.allocatedBytes, queries: row.requests.length, orderedCandidateParity: true, warmNoRebuild: true, beforeFirstMs: before.requests[0].firstMs, afterFirstMs: row.requests[0].firstMs, beforeWarmMs: before.requests.map(request => request.warmMs), afterWarmMs: row.requests.map(request => request.warmMs) }
    })
    assert.ok(rows.filter(row => row.name !== 'small').every(row => row.reductionPercent >= 25), 'Nontrivial cache storage must shrink by at least 25%')
    save(join(directory, 'baseline-rerun.json'), baseline)
    save(join(directory, 'after.json'), after)
    const rawPath = join(directory, 'evidence.json.gz')
    const raw = gzipSync(JSON.stringify({ baselineRef, corpus, baseline, after, baselineCompilerConfig: fromGit('tsconfig.json'), baselinePackage: fromGit('package.json'), currentImplementation: readFileSync('src/workspace/search-index.ts', 'utf8') }))
    writeFileSync(rawPath, raw)
    const report = { generatedAt: after.generatedAt, kind: 'workspace cache storage regression', node: after.node, sqlite: after.rows[0].sqlite, passed: true, baselineRef, baselineModuleSha256: baseline.moduleSha256, currentModuleSha256: after.moduleSha256, method: 'Fresh isolated SQLite caches, identical pinned Git corpus and absolute paths, default production page size, database and WAL/SHM logical bytes after connections close. Allocated bytes are stat.blocks times 512. Every ordered candidate, truncation signal, limit signal and refresh count compared across 16 questions. Timings are one sequential run and have no latency gate.', limitations: 'Authored fixtures and one repository snapshot. Measures the workspace cache, excluding dependencies, package indexes, executable size and process memory. No competitor or general agent superiority claim. Very small indexes may grow because an additional content table and file lookup index have fixed page costs. Migration rebuild cost is covered by tests but excluded from these fresh cache measurements.', reproduction: `Run npm run build then node scripts/benchmark-storage.mjs. Requires local Git commit ${baselineRef} and installed package dependencies. Reconstructs the baseline and corpus from that immutable commit and compiles it with the same installed compiler and dependencies as the current version. No prior artifact files are required. Optional --baseline-ref <git-commit> explicitly selects a different comparison.`, rawArchive: { path: relative(process.cwd(), rawPath), sha256: digest(raw), bytes: raw.length }, rawEvidence: ['artifacts/competitive/storage/baseline-rerun.json', 'artifacts/competitive/storage/after.json', 'artifacts/competitive/storage/corpus.json'], rows }
    save(resolve('docs/benchmarks/storage.json'), report)
    console.log(JSON.stringify(report, null, 2))
} finally {
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
}
