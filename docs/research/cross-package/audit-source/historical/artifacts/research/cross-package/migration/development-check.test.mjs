import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const checker = pathToFileURL(join(import.meta.dirname, 'development-check.mjs')).href
function simulated(runtime) {
  const source = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; cp.spawnSync = (_command,args) => args.some(arg=>String(arg).endsWith('development-runtime.mjs')) ? ${JSON.stringify(runtime)} : ({status:0,signal:null,stdout:'',stderr:''}); syncBuiltinESMExports(); await import(${JSON.stringify(checker)});`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' })
  return { exitCode: result.status, output: JSON.parse(result.stdout.trim()) }
}
const allPassing = { passed: true, cases: 6, results: Array.from({ length: 6 }, (_, i) => ({ id: 'case-' + i, passed: true })) }
test('nonzero runtime exit cannot pass using an earlier successful JSON line', () => {
  const result = simulated({ status: 7, signal: null, stdout: JSON.stringify(allPassing), stderr: 'Unhandled exception after JSON' })
  assert.equal(result.exitCode, 1); assert.equal(result.output.passed, false)
})
test('runtime capture must confirm all six cases and aggregate pass', () => {
  for (const payload of [{ ...allPassing, passed: false }, { ...allPassing, cases: 5 }, { ...allPassing, results: allPassing.results.slice(0, 5) }, { ...allPassing, results: allPassing.results.map(row => ({ ...row, passed: 'yes' })) }]) {
    const result = simulated({ status: 0, signal: null, stdout: JSON.stringify(payload), stderr: '' })
    assert.equal(result.output.passed, false)
  }
})
