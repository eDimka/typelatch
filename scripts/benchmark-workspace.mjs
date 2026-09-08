import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { workspaceSearchAsync as workspaceSearch } from '../dist/workspace/runtime.js'

// Expected locations are fixed before retrieval. Do not copy this evaluator into the corpus.
const cases = [
  { question: 'validateWorkspace', expected: 'src/workspace/validate.ts' },
  { question: 'verifyIntegrity', expected: 'src/npm.ts' },
  { question: 'recordOutcome', expected: 'src/usage.ts' },
  { question: 'runCommand', expected: 'src/workspace/command.ts' },
  { question: 'registry integrity tarball', expected: 'src/npm.ts' },
  { question: 'timeout command output', expected: 'src/workspace/command.ts' },
  { question: 'same size writes invalidate', expected: 'src/workspace/project.ts' },
  { question: 'cursor definitions references', expected: 'src/workspace/context.ts' }
]
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'typelatch-workspace-benchmark-')))
const root = join(directory, 'repo')
const previousHome = process.env.TYPELATCH_HOME
const rows = []
try {
  process.env.TYPELATCH_HOME = join(directory, 'data')
  mkdirSync(root)
  cpSync('src', join(root, 'src'), { recursive: true })
  cpSync('test', join(root, 'test'), { recursive: true, filter: path => !path.endsWith('workspace-search.test.ts') })
  for (const path of ['README.md', 'docs/USAGE.md', 'docs/ARCHITECTURE.md']) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    cpSync(path, join(root, path))
  }
  execFileSync('git', ['init', '-q', root])
  for (const entry of cases) {
    const cold = await workspaceSearch({ workspaceRoot: root, question: entry.question, scope: 'workspace', limit: 8 })
    const warm = await workspaceSearch({ workspaceRoot: root, question: entry.question, scope: 'workspace', limit: 8 })
    assert.deepEqual(warm.results, cold.results)
    assert.equal(warm.index.updatedFiles, 0)
    const rank = warm.results.findIndex(item => relative(root, item.source) === entry.expected) + 1
    // This is a fixed lexical reference, not an interactive agent or a fair superiority claim.
    const terms = entry.question.match(/[a-zA-Z0-9]+/g) ?? []
    let rgOutput = ''
    const rgStarted = performance.now()
    try { rgOutput = execFileSync('rg', ['-n', '-i', '-e', terms.join('|'), '--', '.'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) }
    catch (error) { if (error.status !== 1) throw error }
    rows.push({
      ...entry, rank, passed: rank > 0, status: warm.status,
      firstQueryMs: cold.latencyMs, warmQueryMs: warm.latencyMs,
      firstSearchMs: cold.searchMs, warmSearchMs: warm.searchMs,
      firstQueryUpdatedFiles: cold.index.updatedFiles, warmUpdatedFiles: warm.index.updatedFiles,
      resultBytes: Buffer.byteLength(JSON.stringify(warm.results)), responseBytes: Buffer.byteLength(JSON.stringify(warm)),
      rg: { args: ['-n', '-i', '-e', terms.join('|'), '--', '.'], latencyMs: Math.round(performance.now() - rgStarted), bytes: Buffer.byteLength(rgOutput), lines: rgOutput.trim().split('\n').filter(Boolean).length, output: rgOutput },
      results: warm.results.map(item => ({ ...item, source: relative(root, item.source), projectRoot: '.', dependencyRoots: [] })),
      coverage: { complete: warm.coverage.complete, files: warm.coverage.files, issues: warm.coverage.issues.map(issue => issue.replaceAll(root, '<workspace>')), retrieval: warm.coverage.retrieval }
    })
  }
  const report = {
    generatedAt: new Date().toISOString(), kind: 'authored workspace retrieval regression',
    corpus: 'Current src and test trees excluding workspace-search.test.ts, plus README, usage and architecture docs. No evaluator, dependency installs or prior benchmark reports.',
    limitations: 'Eight known repository questions. The rg reference uses a single OR query and returns all matching lines. These output sizes and timings do not measure agent tokens, coding success, or superiority. Only the first search builds the full cache; later firstQueryMs values reuse it.',
    node: process.version, passed: rows.every(row => row.passed), cases: rows.length, passedCases: rows.filter(row => row.passed).length,
    rows
  }
  mkdirSync('docs/benchmarks', { recursive: true })
  writeFileSync('docs/benchmarks/workspace-search.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases, passedCases: report.passedCases, ranks: rows.map(row => ({ question: row.question, rank: row.rank, warmMs: row.warmQueryMs })) }, null, 2))
  if (!report.passed) process.exitCode = 1
} finally {
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
  rmSync(directory, { recursive: true, force: true })
}
