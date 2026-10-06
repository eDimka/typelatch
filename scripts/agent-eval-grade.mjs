import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const argument = process.argv[2]
if (!argument || !isAbsolute(argument)) throw new Error('Usage: node scripts/agent-eval-grade.mjs <absolute-fixture-root>')
const root = realpathSync(argument)
const scripts = dirname(fileURLToPath(import.meta.url))
const compile = spawnSync(process.execPath, [resolve(scripts, '../node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json'), '--skipLibCheck'], { encoding: 'utf8', timeout: 15_000 })
if (compile.stdout) process.stdout.write(compile.stdout)
if (compile.stderr) process.stderr.write(compile.stderr)
if (compile.error || compile.status !== 0) {
  if (compile.error) console.error(compile.error.message)
  process.exit(compile.status || 1)
}
console.log('TypeScript compile: passed')
const grade = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', join(scripts, 'fixtures/agent-eval-grader.test.mjs')], {
  env: { ...process.env, AGENT_EVAL_WORKSPACE: root }, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024
})
if (grade.stdout) process.stdout.write(grade.stdout)
if (grade.stderr) process.stderr.write(grade.stderr)
if (grade.error) console.error(grade.error.message)
process.exitCode = grade.status ?? 1
