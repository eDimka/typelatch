import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assertResume, taskDescriptions, validateSpec, guidedInstruction, replaySelection } from './run.mjs'
import { taskDescriptions as availabilityTasks } from '../agent-trial/run.mjs'
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)))

test('guided source preparation cannot freeze without explicit reviewed spec status', () => {
  const spec = read('./spec.template.json')
  assert.throws(() => validateSpec(spec), /Review the guided study/u)
  spec.status = 'selected-and-ready'
  assert.doesNotThrow(() => validateSpec(spec))
})
test('the separate study preserves tasks and exact native, Serena and packet launch specifications', () => {
  const original = read('../agent-trial/selected-spec-002.json'), guided = read('./spec.template.json')
  assert.deepEqual(taskDescriptions, availabilityTasks)
  for (const arm of ['native', 'competitor', 'packet']) assert.deepEqual(guided.arms[arm], original.arms[arm])
  assert.deepEqual(guided.fixtures, original.fixtures)
  assert.deepEqual(guided.typelatchArtifact, original.typelatchArtifact)
  assert.deepEqual(guided.candidates, ['packet'])
  assert(!/workspace_validate|workspace_context|library_symbol/u.test(guidedInstruction))
})
test('resume rejects unmatched preparation and active or uncleared processes', () => {
  const protocol = { schedule: [{ id: 'one' }] }
  const original = { complete: false, protocolSha256: 'hash', protocol, preparationAttempts: [{ id: 'one', status: 'ready' }], runs: [{ id: 'one', status: 'completed', processGroupStopped: true, providerStopped: true }] }
  assert.doesNotThrow(() => assertResume(original, protocol, 'hash'))
  for (const mutate of [v => { v.preparationAttempts[0].status = 'failed' }, v => { v.runs[0].providerStopped = false }, v => { v.runs[0].status = 'running' }]) { const value = structuredClone(original); mutate(value); assert.throws(() => assertResume(value, protocol, 'hash')) }
})

test('replay pair is fixed to the first task and repeat before guided outcomes', () => {
  assert.equal(replaySelection.task, taskDescriptions[0].id)
  assert.equal(replaySelection.repeat, 1)
  assert.deepEqual(replaySelection.arms, ['native', 'packet'])
  assert.deepEqual(replaySelection.runIds, ['native', 'packet'].map(arm => `${taskDescriptions[0].id}-r1-${arm}`))
  assert.match(guidedInstruction, /Harmless working-directory checks/u)
  assert.match(guidedInstruction, /targeted dependency\/configuration inspection/u)
})
