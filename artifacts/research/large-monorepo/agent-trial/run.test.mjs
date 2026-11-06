import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assertResume, taskDescriptions, validateSpec } from './run.mjs'

test('unselected competitor cannot freeze a trial', () => {
  const template = JSON.parse(readFileSync(new URL('./spec.template.json', import.meta.url)))
  assert.throws(() => validateSpec(template), /Resolve the strongest control/u)
})
test('resume rejects unmatched preparation, active run and incomplete cleanup', () => {
  const protocol = { schedule: [{ id: 'one' }] }
  const original = { complete: false, protocolSha256: 'hash', protocol, preparationAttempts: [{ id: 'one', status: 'ready' }], runs: [{ id: 'one', status: 'completed', processGroupStopped: true, providerStopped: true }] }
  assert.doesNotThrow(() => assertResume(original, protocol, 'hash'))
  for (const mutate of [value => value.preparationAttempts.push({ id: 'two', status: 'preparing' }), value => value.preparationAttempts[0].status = 'failed', value => value.runs[0].status = 'running', value => value.runs[0].providerStopped = false, value => value.protocolSha256 = 'different']) {
    const value = structuredClone(original); mutate(value); assert.throws(() => assertResume(value, protocol, 'hash'))
  }
})
test('task descriptions do not reveal implementation paths or reference repair', () => {
  assert.equal(taskDescriptions.length, 2)
  for (const task of taskDescriptions) assert(!/getChangedPackages|--no-renames|_lib\/match|b809cfdd/u.test(task.body))
})
