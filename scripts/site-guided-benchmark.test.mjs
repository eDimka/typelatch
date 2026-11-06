import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { verifyGuidedAnimation, verifyGuidedEvidence } from './site-guided-evidence.mjs'
import { guidedArmOrder, renderGuidedAnimation, renderGuidedBenchmark } from './site-guided-benchmark.mjs'

const directory = resolve(import.meta.dirname, '../docs/benchmarks/monorepo-guided-study')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')

function bundle() {
  const manifestBytes = readFileSync(resolve(directory, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const files = new Map(manifest.files.map(file => [file.path, readFileSync(resolve(directory, file.path))]))
  files.set('manifest.json', manifestBytes)
  return {
    files,
    json: path => JSON.parse(files.get(path)),
    replace(path, bytes) {
      files.set(path, bytes)
      const entry = manifest.files.find(file => file.path === path)
      entry.sha256 = hash(bytes); entry.bytes = bytes.length
      files.set('manifest.json', encode(manifest))
    },
    verify: () => verifyGuidedEvidence(path => { assert(files.has(path), `Missing public artifact: ${path}`); return files.get(path) }),
  }
}

test('guided publication renders all three conditions and twelve sessions from verified public evidence', async () => {
  const data = bundle(), verified = await data.verify(), html = renderGuidedBenchmark(verified)
  assert.deepEqual([...html.matchAll(/data-guided-arm="([^"]+)"/gu)].map(match => match[1]), guidedArmOrder)
  assert.equal((html.match(/data-guided-run="/gu) ?? []).length, 12)
  for (const arm of guidedArmOrder) {
    const card = html.match(new RegExp(`<article class="guided-arm-card" data-guided-arm="${arm}">([\\s\\S]*?)<\\/article>`))[1]
    for (const label of ['Total tokens', 'Charged time', 'Correct solutions', 'Workflow followed', 'Grep calls', 'MCP calls']) assert(card.includes(`<dt>${label}</dt>`))
    assert.doesNotMatch(card, /<table|benchmark-table-wrap/)
  }
  assert.match(html, /unpublished Typelatch prototype/)
  assert.match(html, /does not establish scaling/)
  assert.match(html, /Each condition names its available provider/)
  assert.match(html, /href="#monorepo-benchmark"/)
  assert.match(html, /href="#benchmark"/)
  assert.match(html, /pilot-001\/report.json/)
  assert.match(html, /Fewer grep calls\.<br \/><span>More tokens and time\./)
  assert.match(html, /11\.9% more tokens/)
  assert.match(html, /20\.6% more charged time/)
  assert.match(html, /Grep calls fell from 9 to 4/)
})

test('guided verification rejects missing evidence, hidden pilot files and changed bytes', async () => {
  for (const select of [data => data.json('report.json').runs[0].evidence, data => 'pilot-001/' + data.json('pilot-001/report.json').runs[0].evidence]) {
    const data = bundle(); data.files.delete(select(data))
    await assert.rejects(data.verify(), /Missing public artifact/)
  }
  const changed = bundle(), path = changed.json('report.json').runs[0].evidence
  changed.files.set(path, Buffer.concat([changed.files.get(path), Buffer.from(' ')]))
  await assert.rejects(changed.verify(), /artifact digest/)
})

test('guided gate and protocol sources stay frozen even if an export manifest is resealed', async () => {
  for (const path of ['decision.mjs', 'workflow-review.mjs', 'protocol.json']) {
    const data = bundle(); data.replace(path, Buffer.concat([data.files.get(path), Buffer.from('\n')]))
    await assert.rejects(data.verify(), /exact frozen source|frozen before model sessions/)
  }
})

test('a sent provider prompt cannot be replaced by another condition prompt', async () => {
  const data = bundle(), report = data.json('report.json'), run = report.runs[0], record = data.json(run.evidence)
  record.prompt += '\nDifferent provider instructions.'
  const bytes = encode(record); data.replace(run.evidence, bytes); run.evidenceSha256 = hash(bytes); data.replace('report.json', encode(report))
  await assert.rejects(data.verify(), /prompt matches its frozen task/)
})

test('automatic and reviewed decisions are independently recomputed', async () => {
  for (const path of ['report.json', 'adjudication.json']) {
    const data = bundle(), value = data.json(path)
    value.decision.anyCandidatePassed = !value.decision.anyCandidatePassed
    data.replace(path, encode(value))
    await assert.rejects(data.verify(), /automatic decision|reviewed decision/)
  }
})

test('workflow judgments remain bound to the reviewed decision', async () => {
  const data = bundle(), audit = data.json('workflow-audit.json')
  audit.runs[0].instructionFollowed = audit.runs[0].instructionFollowed === 'pass' ? 'fail' : 'pass'
  data.replace('workflow-audit.json', encode(audit))
  await assert.rejects(data.verify())
})

test('normalization receipts must describe the exact published values', async () => {
  const data = bundle(), receipt = data.json('normalization.json')
  const change = receipt.changes.report.find(change => change.afterPresent)
  assert(change, 'Publication records its public bindings and relative links')
  change.afterValueSha256 = '0'.repeat(64)
  data.replace('normalization.json', encode(receipt))
  await assert.rejects(data.verify(), /exact published field value/)
})

test('rendering cannot reuse a previously verified decision after mutation', async () => {
  const verified = await bundle().verify()
  verified.report.runs[0].usage.totalTokens += 1
  assert.throws(() => renderGuidedBenchmark(verified), /measurements were not changed/)
})

async function replay() {
  const root = resolve(import.meta.dirname, '..'), verified = await bundle().verify()
  const animation = JSON.parse(readFileSync(resolve(root, 'site/guided-animation.json')))
  const renderer = readFileSync(resolve(root, 'scripts/monorepo-guided-gif.py'))
  const assets = new Map(Object.values(animation.assets).map(asset => [asset.path, readFileSync(resolve(root, 'site', asset.path))]))
  return { verified, animation, renderer, assets, verify: () => verifyGuidedAnimation(verified, animation, path => assets.get(path), renderer) }
}

test('guided replay binds the original first pair and has a static accessible fallback', async () => {
  const data = await replay(), animation = data.verify(), html = renderGuidedAnimation(animation)
  assert.deepEqual(animation.runs.map(run => run.id), data.verified.report.protocol.replaySelection.runIds)
  assert.match(html, /Recorded public Codex actions/)
  assert.match(html, /Experimental source packet/)
  assert.match(html, /explicit provider inventories/)
  assert.match(html, /prefers-reduced-motion: reduce/)
  assert.match(html, /data-guided-comparison-play[^>]*hidden/)
  assert.match(html, /src="assets\/codex-guided-comparison.png"/)
})

test('guided replay rejects a substituted pair, changed source, changed review or changed media', async () => {
  const selected = await replay(); selected.animation.runs.reverse()
  assert.throws(selected.verify, /pair chosen before results/)
  const renderer = await replay(); renderer.animation.renderer.sha256 = '0'.repeat(64)
  assert.throws(renderer.verify, /renderer/)
  const review = await replay(); review.animation.adjudication.sha256 = '0'.repeat(64)
  assert.throws(review.verify, /reviewed outcome/)
  const media = await replay(), path = media.animation.assets.gif.path
  media.assets.set(path, Buffer.concat([media.assets.get(path), Buffer.from(' ')]))
  assert.throws(media.verify)
})
