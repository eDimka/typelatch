import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { assertResume, taskDescriptions, validateSpec, guidedInstruction, replaySelection, capabilityInventory, makePrompts } from './run.mjs'
import { taskDescriptions as availabilityTasks } from '../agent-trial/run.mjs'
const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url)))

test('guided source preparation cannot freeze without explicit reviewed spec status', () => {
  const spec = read('./spec.template.json')
  assert.throws(() => validateSpec(spec), /Review the inventory study/u)
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

test('same-format inventories explicitly name none or only the actual configured provider', () => {
  const spec = read('./spec.template.json')
  for (const arm of ['native', 'competitor', 'packet']) {
    const value = capabilityInventory(spec, arm), lines = value.split('\n')
    assert.equal(lines.length, 6)
    assert.match(value, /Additional repository providers: none/u)
    assert.match(value, /do not call them to discover providers/u)
    if (arm === 'native') { assert.match(value, /Provider: none\nTools: none/u); assert(!value.includes('mcp__')) }
    if (arm === 'packet') { assert.match(value, /Provider: typelatch_packet/u); assert.match(value, /mcp__typelatch_packet__workspace_evidence/u); assert(!value.includes('mcp__serena')) }
    if (arm === 'competitor') { assert.match(value, /Provider: serena/u); assert.match(value, /mcp__serena__serena_repl/u); assert(!value.includes('mcp__typelatch_packet')) }
  }
  const prompts = makePrompts([{ id: 'task', prompt: 'Unchanged task and policy.' }], spec)
  assert.equal(prompts.length, 3)
  assert(prompts.every(row => row.prompt.startsWith('Unchanged task and policy.\n\nRepository retrieval capability inventory')))
  assert.equal(new Set(prompts.map(row => row.promptSha256)).size, 3)
})

test('proof sources remain frozen even if sharedFrozenInputs omits them', async () => {
  const { inventoryDeclarations } = await import('./run.mjs')
  assert.equal(typeof inventoryDeclarations, 'function')
  const spec = read('./spec.template.json'), required = [spec.supplementalOutputs.extractor, spec.toolUseQualification.receipt, spec.toolUseQualification.sourceSpec]
  spec.sharedFrozenInputs = spec.sharedFrozenInputs.filter(entry => !required.includes(entry.path))
  const entries = inventoryDeclarations(spec, new URL('./spec.template.json', import.meta.url).pathname)
  for (const path of required) assert(entries.some(entry => entry.kind === 'file' && entry.path === path), `Proof dependency is not frozen: ${path}`)
})
