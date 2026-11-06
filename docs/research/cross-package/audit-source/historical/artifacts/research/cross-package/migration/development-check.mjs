import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { targets } from './prepare-development.mjs'
const workspace = resolve(process.argv[2] ?? process.cwd()), tsc = join(workspace, 'node_modules/typescript/bin/tsc')
const run = args => { const start = performance.now(); const r = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }); return { exitCode: r.status, signal: r.signal, elapsedMs: performance.now() - start, stdout: r.stdout, stderr: r.stderr, error: r.error?.message ?? null } }
const clean = run([tsc, '-b', '--clean', ...targets])
const build = clean.exitCode === 0 ? run([tsc, '-b', ...targets]) : null
const results = [{ id: 'native-typescript-build-five-production-packages', passed: clean.exitCode === 0 && build?.exitCode === 0, clean, build }]
let runtime = null
if (results[0].passed) {
  runtime = run([join(import.meta.dirname, 'development-runtime.mjs'), workspace])
  try {
    const parsed = JSON.parse(runtime.stdout)
    if (!Array.isArray(parsed.results)) throw new Error('Missing runtime cases')
    results.push(...parsed.results)
    if (runtime.exitCode !== 0 || runtime.signal !== null || runtime.error !== null || parsed.passed !== true || parsed.cases !== 6 || parsed.results.length !== 6 || parsed.results.some(row => row.passed !== true)) {
      if (results.every(row => row.passed === true)) results.push({ id: 'runtime-capture-complete', passed: false })
    }
  } catch { results.push({ id: 'runtime-results', passed: false, runtime }) }
} else results.push({ id: 'runtime-results', passed: false, reason: 'Not run because native compilation failed' })
const passed = results.every(row => row.passed === true)
console.log(JSON.stringify({ passed, cases: results.length, results, runtime }))
process.exitCode = passed ? 0 : 1
