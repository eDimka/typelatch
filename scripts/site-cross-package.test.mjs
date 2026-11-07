import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { crossPackageStudies, renderCrossPackageBenchmark, verifyCrossPackageEvidence, verifyCrossPackageAnimation, renderCrossPackageAnimation } from './site-cross-package.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const directory = resolve(import.meta.dirname, '../docs/research/cross-package')

function displayFixture(id = 'impact-002') {
  const study = crossPackageStudies.find(study => study.id === id)
  const runs = ['native', study.candidate, 'competitor'].map((arm, index) => ({
    id: `display-fixture-${arm}`, task: 'display-fixture', arm, correct: true,
    capture: { complete: true }, processGroupStopped: true, providerStopped: true,
    providerSetupMs: 100, elapsedMs: index === 1 ? 700 : 1000,
    usage: { totalTokens: index === 1 ? 70 : 100 }, counts: { grepShellCalls: 2, mcpCalls: arm === 'native' ? 0 : 1 },
    nativeValidation: { checks: [] },
  }))
  return { study, report: { protocol: { decisionGate: { minimumReductionPercent: 20 }, tasks: [{ id: 'display-fixture', category: id === 'maintenance-001' ? 'maintenance' : 'impact', mode: id === 'maintenance-001' ? 'edit' : 'analysis', scope: { productionPackages: 3 } }] }, runs, decision: { measurable: true } }, audit: null, correctnessAudit: null, files: new Map(), verify() {} }
}

function bundle(id) {
  const base = resolve(directory, id), manifestBytes = readFileSync(resolve(base, 'results/manifest.json')), manifest = JSON.parse(manifestBytes)
  const files = new Map([['protocol.json', readFileSync(resolve(base, 'protocol.json'))], ['freeze.json', readFileSync(resolve(base, 'freeze.json'))], ['results/manifest.json', manifestBytes]])
  for (const file of manifest.files) files.set(`results/${file.path}`, readFileSync(resolve(base, 'results', file.path)))
  return { files, manifest,
    replace(path, value) {
      const bytes = encode(value); files.set(path, bytes)
      const entry = manifest.files.find(file => `results/${file.path}` === path)
      if (entry) { entry.sha256 = hash(bytes); entry.bytes = bytes.length; files.set('results/manifest.json', encode(manifest)) }
    },
    verify: () => verifyCrossPackageEvidence(id, path => { assert(files.has(path), `Missing public evidence: ${path}`); return files.get(path) }),
  }
}

test('unpublished studies do not produce result placeholders', () => {
  assert.equal(renderCrossPackageBenchmark([]), '')
  assert.throws(() => verifyCrossPackageEvidence('invented-heldout', () => Buffer.from('{}')), /Unreviewed studies/)
})

test('development cards expose all conditions and cost metrics without horizontal scrolling', () => {
  const html = renderCrossPackageBenchmark([displayFixture()])
  assert.deepEqual([...html.matchAll(/data-cross-package-arm="([^"]+)"/gu)].map(match => match[1]), ['native', 'impact', 'competitor'])
  for (const name of ['Total tokens', 'Charged time', 'Independent correctness', 'Workflow review', 'Complete public validation', 'Grep calls', 'MCP calls']) assert(html.includes(`<dt>${name}</dt>`))
  assert.doesNotMatch(html, /<table/u)
  assert.match(html, /One repetition per condition/u)
  assert.match(html, /Pending review/u)
  assert.match(html, /advantage on unseen tasks has not been established/u)
  assert.match(html, /unpublished prototype/u)
  assert.match(html, /first relevant investigation/u)
  assert.match(html, /default autonomous adoption is untested/u)
  assert.match(html, /#guided-benchmark/u)
  assert.doesNotMatch(html, /[—–]/u)
})

test('a cost regression cannot receive the lower cost headline', () => {
  const value = displayFixture(); value.report.runs[1].usage.totalTokens = 200
  const html = renderCrossPackageBenchmark([value])
  assert.doesNotMatch(html, /Lower measured cost/u)
  assert.match(html, /Total tokens<\/dt><dd>200<\/dd>/u)
})

test('pending or failed workflow review cannot produce a savings summary', () => {
  for (const workflow of [null, 'fail', 'unknown']) {
    const value = displayFixture()
    if (workflow) value.audit = { runs: value.report.runs.map(run => ({ id: run.id, workflow })) }
    const html = renderCrossPackageBenchmark([value])
    assert.doesNotMatch(html, /Lower measured cost|Candidate versus/u)
  }
})

test('a complete passing workflow permits a scoped development comparison', () => {
  const value = displayFixture()
  value.audit = { runs: value.report.runs.map(run => ({ id: run.id, workflow: 'pass' })) }
  const html = renderCrossPackageBenchmark([value])
  assert.match(html, /Lower measured cost on one development task/u)
  assert.match(html, /30\.00% lower total tokens/u)
  assert.match(html, /One repetition per condition/u)
})

test('a writer token saving with nearly unchanged time fails the joint threshold', () => {
  const value = displayFixture('impact-003')
  value.audit = { runs: value.report.runs.map(run => ({ id: run.id, workflow: 'pass' })) }
  value.report.runs[1].elapsedMs = 995
  const html = renderCrossPackageBenchmark([value])
  assert.match(html, /Impact analysis with a report writer/u)
  assert.match(html, /Did not meet both cost thresholds/u)
  assert.match(html, /30\.00% lower total tokens; 0\.45% lower charged time/u)
  assert.doesNotMatch(html, /Both cost thresholds were observed/u)
})

test('unknown capture counts and usage remain unknown', () => {
  const value = displayFixture(), run = value.report.runs[1]
  run.capture.complete = false; run.usage.totalTokens = null; run.correct = null
  run.elapsedMs = null
  const html = renderCrossPackageBenchmark([value])
  const card = html.match(/data-cross-package-arm="impact">([\s\S]*?)<\/article>/u)[1]
  for (const name of ['Total tokens', 'Charged time', 'Grep calls', 'MCP calls']) assert(card.includes(`<dt>${name}</dt><dd>Unknown</dd>`))
  assert.match(card, /1 unknown/u)
  assert.doesNotMatch(html, /Lower measured cost/u)
})

test('an earlier passing public check does not conceal a later failed check', () => {
  const value = displayFixture('maintenance-001')
  value.report.runs[1].nativeValidation.checks = [{ completePassingCheck: true }, { completePassingCheck: false }]
  const html = renderCrossPackageBenchmark([value])
  const card = html.match(/data-cross-package-arm="typelatch">([\s\S]*?)<\/article>/u)[1]
  assert.match(card, /Complete public validation<\/dt><dd>Not observed/u)
})

test('environment limited maintenance retains repair grades without claiming completed public validation', () => {
  const value = displayFixture('maintenance-001'); value.report.decision.measurable = false
  for (const run of value.report.runs) run.nativeValidation.checks = [{ completePassingCheck: false }]
  const html = renderCrossPackageBenchmark([value])
  assert.match(html, /Independent correctness<\/dt><dd>1 \/ 1/u)
  assert.match(html, /Complete public validation<\/dt><dd>Not observed/u)
  assert.match(html, /prevent a complete comparison/u)
  assert.match(html, /Independent repair checks and the agent’s public validation are separate/u)
  assert.doesNotMatch(html, /Candidate versus|Lower measured cost/u)
})

for (const study of crossPackageStudies) {
  const ready = existsSync(resolve(directory, study.id, 'results/report.json'))
  test(`${study.id}: verify every published run, output and review`, { skip: !ready }, () => {
    const data = bundle(study.id), verified = data.verify(), html = renderCrossPackageBenchmark([verified])
    assert.equal((html.match(/data-cross-package-run="/gu) ?? []).length, verified.report.runs.length)
    if (verified.audit && verified.adjudication) assert.equal(verified.adjudicationCurrent, true, 'Adjudication hashes parsed canonical audit while manifest hashes its file bytes')
    assert.equal(verified.files.size, data.files.size)
    verified.report.runs[0].usage.totalTokens += 1
    assert.throws(() => renderCrossPackageBenchmark([verified]), /has not changed/u)
  })
  test(`${study.id}: missing or changed records cannot be published`, { skip: !ready }, () => {
    const data = bundle(study.id), path = [...data.files.keys()].find(path => path.endsWith('/public-evidence.json'))
    data.files.delete(path)
    assert.throws(data.verify, /Missing public evidence/u)
    const tampered = bundle(study.id)
    tampered.files.set(path, Buffer.from('{}'))
    assert.throws(tampered.verify, /digest matches/u)
  })
  test(`${study.id}: resealing a manifest cannot hide a removed run or a changed protocol`, { skip: !ready }, () => {
    const data = bundle(study.id), report = JSON.parse(data.files.get('results/report.json'))
    report.runs.pop(); data.replace('results/report.json', report)
    assert.throws(data.verify, /Every scheduled run/u)
    const changed = bundle(study.id), protocol = JSON.parse(changed.files.get('protocol.json'))
    protocol.phase = 'heldout'; changed.replace('protocol.json', protocol)
    assert.throws(changed.verify, /reviewed frozen source/u)
  })
}


test('normalized quote exception is bound to the exact command and action', { skip: !existsSync(resolve(directory, 'maintenance-001/results/report.json')) }, () => {
  const data = bundle('maintenance-001'), report = JSON.parse(data.files.get('results/report.json'))
  const run = report.runs.find(run => run.arm === 'typelatch')
  const path = `results/runs/${run.id}/public-evidence.json`
  const record = JSON.parse(data.files.get(path))
  const action = record.actions.find(action => action.idSha256 === 'b40ee9c64c8028e7786be4b1266661a398dfa60613358262a0ce9e36bddd365d')
  action.command += ' '
  data.replace(path, record)
  run.evidenceSha256 = hash(data.files.get(path))
  data.replace('results/report.json', report)
  assert.throws(data.verify, /ambiguous/u)
})

const animationPath = resolve(import.meta.dirname, '../site/impact-animation.json')
function replay() {
  const verified = bundle('impact-002').verify(), animation = JSON.parse(readFileSync(animationPath))
  const renderer = readFileSync(resolve(import.meta.dirname, 'cross-package-gif.py'))
  const assets = path => readFileSync(resolve(import.meta.dirname, '../site', path))
  return { verified, animation, renderer, assets }
}
test('impact replay binds the preselected actual pair and preserves the old replay', { skip: !existsSync(animationPath) }, () => {
  const { verified, animation, renderer, assets } = replay()
  verifyCrossPackageAnimation(verified, animation, assets, renderer)
  const html = renderCrossPackageAnimation(animation)
  assert.match(html, /data-impact-comparison-play[^>]*hidden/u)
  assert.match(html, /prefers-reduced-motion/u)
  assert.match(html, /one development task/u)
  assert.match(html, /Final measured totals only/u)
  assert(existsSync(resolve(import.meta.dirname, '../site/assets/codex-guided-comparison.gif')))
})
test('impact replay rejects substituted evidence, review, renderer, action times and media', { skip: !existsSync(animationPath) }, () => {
  const { verified, animation, renderer, assets } = replay()
  for (const mutate of [
    value => { value.runs[1].id = value.runs[0].id },
    value => { value.report.sha256 = '0'.repeat(64) },
    value => { value.workflowAudit.sha256 = '0'.repeat(64) },
    value => { value.playback.eventTimes.pop() },
    value => { value.playback.renderedActionIds[value.runs[0].id].pop() },
    value => { value.renderer.sha256 = '0'.repeat(64) },
    value => { value.assets.gif.sha256 = '0'.repeat(64) },
  ]) {
    const changed = structuredClone(animation); mutate(changed)
    assert.throws(() => verifyCrossPackageAnimation(verified, changed, assets, renderer))
  }
})
