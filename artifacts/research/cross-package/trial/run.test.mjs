import assert from 'node:assert/strict'
import test from 'node:test'
import { assertResume, taskPrompt, validateSpec, makePrompts, validationObservation } from './run.mjs'

const provider = (name, tools) => ({ servers: { [name]: { command: '/runtime/server', args: [], cwd: '{workspace}', tools } }, setupCommands: [], frozenInputs: [{ path: '/runtime', kind: 'tree' }], allowedStateLinks: [], cleanupMode: 'process-group' })
const providers = { candidates: ['typelatch'], arms: { native: { servers: {}, setupCommands: [], frozenInputs: [], allowedStateLinks: [], cleanupMode: 'process-group' }, typelatch: provider('typelatch', ['workspace_search', 'workspace_context']), competitor: provider('serena', ['initial_instructions', 'serena_repl']) }, typelatchArtifact: { manifest: '/artifact.json', runtime: '/runtime/typelatch' }, competitorSelection: { name: 'Serena', version: '2.1.0', reason: 'Explicit synthetic test configuration.', evidencePath: '/selection.json' } }
function fixture(mode = 'edit') {
  const id = 'cross-package-example'
  const task = { id, category: mode === 'edit' ? 'migration' : 'impact', split: 'development', mode, description: 'Update the real shared contract and every production consumer while preserving unrelated behavior.', policy: 'Preserve the pinned dependency identity and unrelated consumers.', scope: { productionPackages: 3 }, ...(mode === 'edit' ? { validationCommand: 'npm run test:typelatch-benchmark', publicCases: 3 } : { answerFile: 'impact-answer.json' }) }
  return { ...structuredClone(providers), schemaVersion: 1, status: 'selected-and-ready', phase: 'development', repeats: 1, timeoutMs: 900000, tasks: [task], fixtures: { [id]: { workspace: '/fixture', initialManifest: '/manifest', qualification: '/qualification', sourceTrackingManifest: '/tracking', graderModule: '/grader' } }, sharedFrozenInputs: [{ path: '/loader', kind: 'file' }], supplementalOutputs: { extractor: '/extractor', fileName: 'tool-outputs.json' }, toolUseQualification: { receipt: '/receipt', sourceSpec: '/source' } }
}

test('edit and analysis use different validation obligations with identical provider inventory format', () => {
  const edit = fixture(), analysis = fixture('analysis')
  assert.doesNotThrow(() => validateSpec(edit)); assert.doesNotThrow(() => validateSpec(analysis))
  assert.match(taskPrompt(edit.tasks[0]), /Before investigating implementation/u)
  assert(!taskPrompt(analysis.tasks[0]).includes('Before investigating implementation'))
  assert.match(taskPrompt(analysis.tasks[0]), /Do not change implementation/u)
  const task = { ...edit.tasks[0], prompt: taskPrompt(edit.tasks[0]) }
  const prompts = makePrompts([task], edit)
  assert.equal(prompts.length, 3)
  for (const row of prompts) assert(row.prompt.startsWith(task.prompt + '\n\nRepository retrieval capability inventory'))
})

test('one-package, split-contaminated and path-escaping tasks cannot freeze', () => {
  for (const mutate of [s => { s.tasks[0].scope.productionPackages = 1 }, s => { s.tasks[0].split = 'heldout' }, s => { s.phase = 'confirmation' }, s => { s.tasks[0].publicCases = null }]) { const spec = fixture(); mutate(spec); assert.throws(() => validateSpec(spec)) }
  const spec = fixture('analysis'); spec.tasks[0].answerFile = '../outside.json'; assert.throws(() => validateSpec(spec))
})

test('resume preserves complete attempts and rejects interrupted preparation or uncleared processes', () => {
  const protocol = { schedule: [{ id: 'one' }] }, original = { complete: false, protocolSha256: 'hash', protocol, preparationAttempts: [{ id: 'one', status: 'ready' }], runs: [{ id: 'one', status: 'completed', processGroupStopped: true, providerStopped: true }] }
  assert.doesNotThrow(() => assertResume(original, protocol, 'hash'))
  for (const mutate of [r => { r.preparationAttempts[0].status = 'failed' }, r => { r.runs[0].providerStopped = false }, r => { r.runs[0].status = 'running' }]) { const copy = structuredClone(original); mutate(copy); assert.throws(() => assertResume(copy, protocol, 'hash')) }
})

test('native compiler failure retains partial case count and only a complete passing recheck qualifies', () => {
  const event = (id, passed, count) => JSON.stringify({ type: 'item.completed', item: { id, type: 'command_execution', command: 'npm run test:typelatch-benchmark', exit_code: passed ? 0 : 1, aggregated_output: JSON.stringify({ passed, cases: count, results: Array.from({ length: count }, () => ({ passed })) }) } })
  const result = validationObservation(event('first', false, 2) + '\n' + event('second', true, 7), 7)
  assert.equal(result.failingThenLaterCheckObserved, true)
  assert.deepEqual(result.checks.map(c => c.cases), [2, 7])
  assert.equal(result.checks.at(-1).completePassingCheck, true)
  assert.equal(validationObservation(event('first', false, 2) + '\n' + event('second', true, 6), 7).checks.at(-1).completePassingCheck, false)
  assert.equal(validationObservation(event('first', true, 7), 7).failingThenLaterCheckObserved, false)
})
