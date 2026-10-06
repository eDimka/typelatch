import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { arch, cpus, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { loadCorpus, corpusCaseFile } from '../dist/benchmark/corpus.js'
import { buildBrain } from '../dist/indexer.js'
import { getSymbol, queryBrain } from '../dist/query.js'

const root = resolve('artifacts/competitive/package-storage', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(root, { recursive: true })
const sha256 = data => createHash('sha256').update(data).digest('hex')
const rows = []
const observations = []
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1]
const representations = path => {
  const db = new Database(path, { readonly: true })
  try {
    return {
      // Raw implementation text and unused edge evidence are intentionally omitted by trimmed storage.
      symbols: db.prepare(`SELECT n.qualified_name, s.name, s.kind, s.module, s.signature, s.docs, s.source_path,
        s.line_start, s.line_end, s.is_public, s.is_deprecated, s.is_internal, s.category, s.example_count
        FROM symbols s JOIN nodes n ON n.id = s.id ORDER BY n.qualified_name`).all(),
      edges: db.prepare(`SELECT a.qualified_name AS source, e.type, b.qualified_name AS target
        FROM edges e JOIN nodes a ON a.id = e.from_id JOIN nodes b ON b.id = e.to_id
        ORDER BY source, e.type, target`).all()
    }
  } finally { db.close() }
}

for (const entry of loadCorpus().packages) {
  console.error(`Package storage: ${entry.name}@${entry.version}`)
  const paths = Object.fromEntries(['compact', 'trimmed'].map(format => [format, join(root, `${encodeURIComponent(entry.name)}-${format}.db`)]))
  const builds = {}
  for (const format of ['compact', 'trimmed']) {
    const started = performance.now()
    const built = await buildBrain(`${entry.name}@${entry.version}`, { output: paths[format], format })
    assert.equal(built.metadata.integrity, entry.integrity)
    assert.equal(built.metadata.brainBytes, statSync(paths[format]).size)
    builds[format] = { bytes: statSync(paths[format]).size, gzipBytes: gzipSync(readFileSync(paths[format])).length, buildMs: performance.now() - started, sha256: sha256(readFileSync(paths[format])) }
  }
  const compact = representations(paths.compact)
  const trimmed = representations(paths.trimmed)
  assert.deepEqual(trimmed, compact, `Stored API evidence changed: ${entry.name}`)
  const cases = corpusCaseFile(entry.name)
  const samples = { compact: [], trimmed: [] }
  for (let round = 0; round < 12; round++) {
    for (const test of cases) {
      const results = {}
      for (const format of round % 2 ? ['trimmed', 'compact'] : ['compact', 'trimmed']) {
        const started = performance.now()
        const response = queryBrain(entry.name, test.question, { version: entry.version, brainFile: paths[format], recordUsage: false })
        samples[format].push(performance.now() - started)
        results[format] = response.results
      }
      assert.deepEqual(results.trimmed, results.compact, `${entry.name}: ${test.question}`)
      if (round === 0) observations.push({ package: entry.name, version: entry.version, question: test.question, expected: test.expected, results })
    }
  }
  for (const symbol of compact.symbols) {
    const options = { version: entry.version, recordUsage: false }
    assert.deepEqual(getSymbol(entry.name, symbol.qualified_name, { ...options, brainFile: paths.trimmed }).results,
      getSymbol(entry.name, symbol.qualified_name, { ...options, brainFile: paths.compact }).results)
  }
  rows.push({ package: entry.name, version: entry.version, integrity: entry.integrity, symbols: compact.symbols.length, edges: compact.edges.length,
    questions: cases.length, rounds: 12, builds,
    latency: Object.fromEntries(Object.entries(samples).map(([format, values]) => [format, { samples: values.length, medianMs: quantile(values, .5), p95Ms: quantile(values, .95) }])),
    parity: { storedApiEvidence: true, allExactSymbols: true, rankedResults: true }, reduction: 1 - builds.trimmed.bytes / builds.compact.bytes })
}
const raw = gzipSync(JSON.stringify(observations))
writeFileSync(join(root, 'responses.json.gz'), raw)
const totals = rows.reduce((sum, row) => ({
  compactBytes: sum.compactBytes + row.builds.compact.bytes, trimmedBytes: sum.trimmedBytes + row.builds.trimmed.bytes,
  compactGzipBytes: sum.compactGzipBytes + row.builds.compact.gzipBytes, trimmedGzipBytes: sum.trimmedGzipBytes + row.builds.trimmed.gzipBytes,
  symbols: sum.symbols + row.symbols, edges: sum.edges + row.edges, questions: sum.questions + row.questions
}), { compactBytes: 0, trimmedBytes: 0, compactGzipBytes: 0, trimmedGzipBytes: 0, symbols: 0, edges: 0, questions: 0 })
const report = {
  generatedAt: new Date().toISOString(), kind: 'Pinned package storage and observable evidence parity',
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  methodology: 'Build compact and trimmed from the same registry integrity pins. Compare all stored API fields, all graph endpoints and types, every exact symbol result, and 12 interleaved repetitions of the 73 existing questions. Timings include synchronous database open and close. Build timing includes registry and download work and is not a speed claim.',
  limitations: 'Index bytes only. Excludes install dependencies, npm cache, peak memory and workspace indexes. Trimmed intentionally omits raw implementation text and unused edge evidence. Public responses retain signatures, summaries, locations and relationships. Authored regression corpus, not an agent success benchmark. Small databases retain SQLite schema overhead. Timing has no pass threshold.',
  sourceHashes: Object.fromEntries(['src/indexer.ts', 'src/database.ts', 'src/query.ts', 'src/benchmark/corpus.json', 'scripts/benchmark-package-storage.mjs'].map(path => [path, sha256(readFileSync(path))])),
  totals, reduction: 1 - totals.trimmedBytes / totals.compactBytes,
  passed: rows.every(row => row.builds.trimmed.bytes <= row.builds.compact.bytes) && totals.trimmedBytes < totals.compactBytes,
  raw: { path: join(root, 'responses.json.gz'), sha256: sha256(raw) }, rows
}
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
mkdirSync('docs/benchmarks', { recursive: true })
writeFileSync('docs/benchmarks/package-storage.json', JSON.stringify({ ...report, raw: { ...report.raw, path: report.raw.path.replace(resolve('.') + '/', '') } }, null, 2) + '\n')
console.log(JSON.stringify({ passed: report.passed, ...totals, reduction: report.reduction, artifact: root }, null, 2))
assert(report.passed, 'Package storage must shrink with no per-package size regression')
