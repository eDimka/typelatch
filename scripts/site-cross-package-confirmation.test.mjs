import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { confirmationConditions, confirmationProtocols, impactConfirmation, verifyConfirmationProtocol, verifyConfirmationEvidence, verifyConfirmationPreparationFailure, renderConfirmationBenchmark, verifyConfirmationAnimation } from './site-cross-package-confirmation.mjs'

const directory = resolve(import.meta.dirname, '../docs/research/cross-package/confirmation-002')

test('confirmation retains all four arms and makes CodeGraph a control', () => {
  const protocol = verifyConfirmationProtocol(readFileSync(resolve(directory, 'protocol.json')), readFileSync(resolve(directory, 'freeze.json')))
  assert.equal(protocol.runCount, 16)
  assert.equal(confirmationConditions.filter(condition => condition.role === 'candidate').length, 1)
  assert.equal(confirmationConditions.find(condition => condition.id === 'codegraph').role, 'control')
  assert.equal(confirmationConditions.find(condition => condition.role === 'candidate').id, 'impact')
  assert.match(impactConfirmation.scope, /same Vue snapshot/u)
  assert.match(impactConfirmation.limitation, /default autonomous adoption/u)
})

test('changed schedule, scope or protocol cannot become a confirmation result', () => {
  const protocol = JSON.parse(readFileSync(resolve(directory, 'protocol.json')))
  protocol.schedule.pop()
  assert.throws(() => verifyConfirmationProtocol(Buffer.from(JSON.stringify(protocol)), readFileSync(resolve(directory, 'freeze.json'))))
})


test('the original preparation failure stays separate and cannot produce a qualifying result', () => {
  const oldDirectory = resolve(directory, '../confirmation-001')
  const old = verifyConfirmationProtocol(readFileSync(resolve(oldDirectory, 'protocol.json')), readFileSync(resolve(oldDirectory, 'freeze.json')), 'confirmation-001')
  const current = verifyConfirmationProtocol(readFileSync(resolve(directory, 'protocol.json')), readFileSync(resolve(directory, 'freeze.json')))
  assert.equal(confirmationProtocols['confirmation-001'].eligibleForOutcomes, false)
  assert.equal(impactConfirmation.id, 'confirmation-002')
  for (const key of ['prompts', 'config', 'arms', 'candidates', 'schedule', 'decisionGate', 'reviewRules', 'replaySelection']) assert.deepEqual(current[key], old[key], `Preparation amendment preserves ${key}`)
})

const bytes = path => readFileSync(resolve(directory, path))
const hash = value => createHash('sha256').update(value).digest('hex')
function rewritten(path, mutate) {
  const value = JSON.parse(bytes(`results/${path}`))
  mutate(value)
  const replacement = Buffer.from(JSON.stringify(value))
  const manifest = JSON.parse(bytes('results/manifest.json'))
  const entry = manifest.files.find(item => item.path === path)
  entry.sha256 = hash(replacement); entry.bytes = replacement.length
  return name => name === `results/${path}` ? replacement : name === 'results/manifest.json' ? Buffer.from(JSON.stringify(manifest)) : bytes(name)
}

test('all 16 confirmation sessions reproduce the original and all control gates', async () => {
  const verified = await verifyConfirmationEvidence(bytes)
  assert.equal(verified.report.runs.length, 16)
  assert.equal(verified.challenge.qualifiedAcrossMeasuredControls, false)
  assert.equal(verified.adjudication.decision.candidates.impact.categories.impact.qualifiedEdge, false)
  assert.equal(verified.assessment.summary.originalStrictPass, 11)
  assert.equal(verified.assessment.summary.assessedPass, 15)
  const html = renderConfirmationBenchmark(verified)
  assert.match(html, /The gate still failed/)
  assert.match(html, /15\.47% lower total tokens/)
  assert.match(html, /22\.08% lower charged time/)
  assert.match(html, /1\.49% lower tokens/)
  assert.match(html, /9\.19% higher tokens/)
  assert.match(html, /1\.27% higher charged time/)
  assert.match(html, /749,471/)
  assert.match(html, /886,587/)
  assert.match(html, /1,597,731/)
  assert.match(html, /1,526,064/)
  assert.equal((html.match(/data-confirmation-arm=/gu) ?? []).length, 4)
  assert.equal((html.match(/data-confirmation-run=/gu) ?? []).length, 16)
  assert.match(html, /Original machine grade/)
  assert.match(html, /Audited correctness/)
  assert.match(html, /same Vue snapshot/)
  assert.match(html, /default autonomous adoption/)
  assert.doesNotMatch(html, /[\u2013\u2014]/u)
  verified.report.runs[0].usage.totalTokens++
  assert.throws(() => renderConfirmationBenchmark(verified), /identical to verified evidence/)
})

test('missing and changed public evidence blocks publication', async () => {
  const run = JSON.parse(bytes('results/report.json')).runs[0]
  await assert.rejects(verifyConfirmationEvidence(path => path.endsWith(`/runs/${run.id}/tool-outputs.json`) ? Buffer.from('{}') : bytes(path)), /digest matches/)
  const manifest = JSON.parse(bytes('results/manifest.json'))
  manifest.files = manifest.files.filter(item => item.path !== 'occurrence-assessment-v1.json')
  await assert.rejects(verifyConfirmationEvidence(path => path === 'results/manifest.json' ? Buffer.from(JSON.stringify(manifest)) : bytes(path)), /Manifest includes occurrence/)
})

test('the mandatory fourth control decision cannot be promoted by editing its result', async () => {
  await assert.rejects(verifyConfirmationEvidence(rewritten('codegraph-challenge.json', value => { value.qualifiedAcrossMeasuredControls = true })), /Every measured control/)
  await assert.rejects(verifyConfirmationEvidence(rewritten('adjudicated-result.json', value => { value.decision.anyQualifiedEdge = true })), /frozen review gate/)
})

test('copy receipts preserve the bound no fallback mechanism', async () => {
  const run = JSON.parse(bytes('results/report.json')).runs[0]
  await assert.rejects(verifyConfirmationEvidence(rewritten(`runs/${run.id}/fixture-copy.json`, value => { value.exitCode = 1 })))
})

test('an occurrence correction cannot erase an unrelated answer error', async () => {
  await assert.rejects(verifyConfirmationEvidence(rewritten('occurrence-assessment-v1.json', value => {
    const row = value.runs.find(row => row.classification === 'substantive-error-retained')
    row.assessedCorrect = true
  })))
  await assert.rejects(verifyConfirmationEvidence(rewritten('occurrence-assessment-v1.json', value => {
    const row = value.runs.find(row => row.changedByErratum)
    row.assessment.groups[0].proof[1] = row.assessment.groups[0].proof[0]
  })), /reviewed final source/)
})

test('preparation failure remains outside all model session totals', () => {
  const result = verifyConfirmationPreparationFailure(path => readFileSync(resolve(directory, '../confirmation-001', path)))
  assert.equal(result.files.size, 5)
  assert.equal(JSON.parse(result.files.get('preparation-report.json')).runs.length, 0)
})


test('the actual replay retains the first pair, every action and the failed overall gate', async () => {
  const verified = await verifyConfirmationEvidence(bytes)
  const site = resolve(directory, '../../../../site')
  const renderer = readFileSync(resolve(directory, '../../../../scripts/cross-package-confirmation-gif.py'))
  const animation = JSON.parse(readFileSync(resolve(site, 'cross-package-confirmation-animation.json')))
  const readAsset = path => readFileSync(resolve(site, path))
  verifyConfirmationAnimation(verified, animation, readAsset, renderer)
  const promoted = structuredClone(animation)
  promoted.fullStudy.qualifiedEdge = true
  assert.throws(() => verifyConfirmationAnimation(verified, promoted, readAsset, renderer), /failed full study gate/)
  const omitted = structuredClone(animation)
  omitted.playback.renderedActionIds[omitted.runs[0].id].pop()
  assert.throws(() => verifyConfirmationAnimation(verified, omitted, readAsset, renderer))
  const changed = structuredClone(animation)
  changed.occurrenceAssessment.sha256 = '0'.repeat(64)
  assert.throws(() => verifyConfirmationAnimation(verified, changed, readAsset, renderer))
  assert.throws(() => verifyConfirmationAnimation(verified, animation, readAsset, Buffer.from('changed')))
})
