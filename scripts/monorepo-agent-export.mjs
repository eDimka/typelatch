import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { normalizeDemo } from './demo-evidence.mjs'
import { evaluateDecision } from '../artifacts/research/large-monorepo/agent-trial/decision.mjs'

const root = resolve(import.meta.dirname, '..')
const study = resolve(process.argv[2] || 'artifacts/research/large-monorepo/agent-study-002')
const destination = resolve(process.argv[3] || 'docs/benchmarks/monorepo-agent-study')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const report = read(join(study, 'report-private.json'))
const publicProtocol = read(join(destination, 'protocol.json'))
assert.equal(report.complete, true, 'Export every scheduled session after the coordinator completes')
assert.equal(report.runs.length, report.protocol.schedule.length)
assert.equal(hash(readFileSync(join(study, 'protocol.json'))), report.protocolSha256)
assert.equal(publicProtocol.privateProtocolSha256, report.protocolSha256)
assert.deepEqual(report.decision, evaluateDecision(report), 'Retain the frozen decision without post hoc thresholds')

const files = []
const write = (path, bytes) => {
  const text = Buffer.from(bytes).toString('utf8')
  assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(text), 'Private filesystem path in public export')
  writeFileSync(join(destination, path), bytes)
  files.push({ path, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) })
}
mkdirSync(join(destination, 'runs'), { recursive: true })
const decisionPath = join(root, 'artifacts/research/large-monorepo/agent-trial/decision.mjs')
const decisionBytes = readFileSync(decisionPath)
assert.equal(hash(decisionBytes), report.protocol.inputs.find(input => input.path === decisionPath)?.sha256, 'Publish the exact frozen decision implementation')
write('decision.mjs', decisionBytes)
const runs = report.runs.map(run => {
  const bytes = readFileSync(join(study, 'runs', run.id, 'public-evidence.json'))
  assert.equal(hash(bytes), run.evidenceSha256, `Exact evidence bytes for ${run.id}`)
  const record = JSON.parse(bytes)
  const { evidenceSha256, ...measurements } = run
  assert.deepEqual(record.run, measurements, `Run summary matches recorded evidence for ${run.id}`)
  const evidence = `runs/${run.id}.json`
  write(evidence, bytes)
  return { ...run, evidence }
})
const normalized = normalizeDemo({ ...report, protocol: publicProtocol.protocol, runs }, [[study, '$STUDY'], [root, '$REPOSITORY'], [homedir(), '$USER_HOME']])
normalized.publication = {
  source: 'Completed public actions, independent grading and source changes from every scheduled run. Model reasoning and assistant message bodies are excluded.',
  protocolHash: 'protocolSha256 binds the private frozen bytes. The public protocol retains that hash and documents path normalization.',
  replaySelection: { task: report.protocol.tasks[0].id, repeat: 1, arms: ['native', 'typelatch'], chosenBeforeResults: true },
}
assert.deepEqual(normalized.decision, evaluateDecision(normalized))
write('report.json', JSON.stringify(normalized, null, 2) + '\n')
for (const path of ['protocol.json', 'protocol-001.json', 'infrastructure-attempt-001.json']) {
  const bytes = readFileSync(join(destination, path))
  files.push({ path, sha256: hash(bytes), bytes: bytes.length })
}
const pilot = read(join(destination, 'infrastructure-attempt-001/report.json'))
for (const path of ['infrastructure-attempt-001/report.json', ...pilot.runs.map(run => `infrastructure-attempt-001/${run.evidence}`)]) {
  const bytes = readFileSync(join(destination, path))
  files.push({ path, sha256: hash(bytes), bytes: bytes.length })
}
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files }, null, 2) + '\n')
console.log(JSON.stringify({ exported: destination, runs: runs.length, decision: normalized.decision }))
