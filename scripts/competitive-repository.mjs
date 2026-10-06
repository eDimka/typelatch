import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const baseline = '0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125'
const root = resolve('artifacts/competitive/repository-fixture')
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, '--', 'src', 'README.md', 'docs/USAGE.md', 'docs/ARCHITECTURE.md'], { encoding: 'utf8' }).trim().split('\n')
for (const path of paths) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), execFileSync('git', ['show', `${baseline}:${path}`]))
}
const casesPath = resolve('artifacts/competitive/repository-cases.json')
const cases = [
  { question: 'validateWorkspace', expected: 'src/workspace/validate.ts' },
  { question: 'verifyIntegrity', expected: 'src/npm.ts' },
  { question: 'recordOutcome', expected: 'src/usage.ts' },
  { question: 'runCommand', expected: 'src/workspace/command.ts' },
  { question: 'registry integrity tarball', expected: 'src/npm.ts' },
  { question: 'timeout command output', expected: 'src/workspace/command.ts' },
  { question: 'same size writes invalidate', expected: 'src/workspace/project.ts' },
  { question: 'cursor definitions references', expected: 'src/workspace/context.ts' }
].map((entry, i) => ({ id: `repository-${i + 1}`, ...entry, lane: 'code' }))
writeFileSync(casesPath, JSON.stringify({ kind: 'Previously authored Typelatch repository regressions, not held out', sourceCommit: baseline, cases }, null, 2) + '\n')
execFileSync(process.execPath, ['scripts/competitive-proof.mjs', process.argv[2] ?? 'docs/benchmarks/competitive-repository.json'], {
  env: { ...process.env, COMPETITIVE_FIXTURE: root, COMPETITIVE_CASES: casesPath, TYPELATCH_DETAIL: process.env.TYPELATCH_DETAIL ?? 'compact' },
  stdio: 'inherit', timeout: 300_000
})
