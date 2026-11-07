import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
const data = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
async function isolatedGrade(result, scope) {
  const token = Math.random().toString(36)
  globalThis[token] = { result, scope, calls: 0 }
  const common = data(`export const grade=()=>globalThis[${JSON.stringify(token)}].result`)
  const scopeModule = data(`export const migrationScope=()=>{const state=globalThis[${JSON.stringify(token)}];state.calls++;return state.scope}`)
  const source = readFileSync(join(import.meta.dirname, 'development-grade.mjs'), 'utf8').replace("'./grading-common.mjs'", JSON.stringify(common)).replace("'./development-scope.mjs'", JSON.stringify(scopeModule)).replaceAll('import.meta.dirname', JSON.stringify(import.meta.dirname))
  try { const mod = await import(data(source)); return { graded: await mod.gradeWorkspace('/unused-fixture', {}), calls: globalThis[token].calls } } finally { delete globalThis[token] }
}
test('failed grades never load the fixture compiler for migration scope', async () => {
  for (const result of [{ passed: false, integrity: { passed: false } }, { passed: false, integrity: { passed: true }, sourceStable: false }, { passed: false, integrity: { passed: true }, checks: { exitCode: 1 } }]) {
    const observation = await isolatedGrade(result, { passed: true })
    assert.equal(observation.graded.passed, false)
    assert.equal(observation.calls, 0)
  }
})
test('otherwise passing grades still require migration scope', async () => {
  for (const passed of [false, true]) {
    const observation = await isolatedGrade({ passed: true, integrity: { passed: true } }, { passed })
    assert.equal(observation.calls, 1); assert.equal(observation.graded.passed, passed)
  }
})
