import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

export function summarizeSupport(path) {
  const raw = readFileSync(path)
  const report = JSON.parse(raw)
  const compressed = gzipSync(raw, { level: 9 })
  const summary = {
    schemaVersion: 1,
    kind: report.kind,
    generatedAt: report.generatedAt,
    manifestHash: report.manifestHash,
    complete: report.complete,
    passed: report.passed,
    navigationPassed: report.navigationPassed,
    totals: report.totals,
    negativeControls: report.packages.reduce((count, row) => count + Object.entries(row.controls ?? {}).filter(([key, value]) => key.endsWith('Rejected') && value === true).length, 0),
    limitations: report.limitations,
    rawEvidence: {
      file: 'support.json.gz',
      sha256: createHash('sha256').update(compressed).digest('hex'),
      format: 'gzip compressed JSON',
      localPath: 'artifacts/support.json.gz'
    },
    packages: report.packages.map(row => ({
      name: row.name,
      version: row.version,
      success: row.success,
      error: row.error,
      tasks: row.tasks.map(task => ({
        id: task.id,
        question: task.request.question,
        support: task.support,
        retrievalHit: task.retrievalHit,
        retrievedCandidateResolved: task.retrievedCandidateResolved,
        navigationMatched: task.navigationMatched,
        checks: task.evidence.checks,
        results: task.evidence.brain?.results.map(result => result.symbol) ?? []
      })),
      validation: row.validation ? { success: row.validation.success, checks: row.validation.checks } : null,
      controls: row.controls ? Object.fromEntries(Object.entries(row.controls).filter(([key]) => key.endsWith('Rejected'))) : null
    }))
  }
  mkdirSync('docs/benchmarks', { recursive: true })
  mkdirSync('artifacts', { recursive: true })
  writeFileSync('artifacts/support.json.gz', compressed)
  writeFileSync('docs/benchmarks/support.json', JSON.stringify(summary, null, 2) + '\n')
  return summary
}
