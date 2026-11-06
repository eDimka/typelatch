import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateDecision } from './decision.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const save = (path, value) => { assert(!existsSync(path), 'Never overwrite an existing review artifact'); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }) }
export function loadPublicReviewContext(reportPath) {
  const reportBytes = readFileSync(reportPath, 'utf8'), report = JSON.parse(reportBytes)
  assert.equal(report.complete, true, 'Review only a fully retained completed study')
  assert.equal(report.runs.length, 12)
  const publicRecords = Object.fromEntries(report.runs.map(run => {
    assert(/^[a-z0-9-]+$/u.test(run.id), 'Run ID must be a single safe path component')
    const bytes = readFileSync(join(dirname(reportPath), 'runs', run.id, 'public-evidence.json'), 'utf8')
    assert.equal(hash(bytes), run.evidenceSha256, 'Public evidence changed')
    return [run.id, bytes]
  }))
  const publicOutputs = Object.fromEntries(report.runs.flatMap(run => { const path = join(dirname(reportPath), 'runs', run.id, 'tool-outputs.json'); return existsSync(path) ? [[run.id, readFileSync(path, 'utf8')]] : [] }))
  return { report, reportBytes, publicRecords, publicOutputs }
}
export function reviewTemplate(reportPath) {
  const { report, reportBytes, publicOutputs } = loadPublicReviewContext(reportPath)
  return { schemaVersion: 1, reportSha256: hash(reportBytes), protocolSha256: report.protocolSha256, reviewer: '', noPrivateReasoningOrMessages: true, instructions: 'Independently inspect only public actions, returned evidence metadata, source changes and native-check records. Do not read raw reasoning or assistant message bodies. Cite action IDs and assess first-investigation ordering and relevance. Unknown is not pass. Preserve every run and all costs.', runs: report.runs.map(run => ({ id: run.id, evidenceSha256: run.evidenceSha256, toolOutputsSha256: publicOutputs[run.id] ? hash(publicOutputs[run.id]) : null, instructionFollowed: 'unknown', firstNativeCheckActionIdSha256: run.nativeValidation?.checks?.[0]?.actionIdSha256 ?? null, firstInvestigationActionIdSha256: null, providerRetrievalActionIdSha256: null, taskRelevant: null, returnedEvidence: 'unknown', rationale: '', limitations: [] })) }
}
export function adjudicate(reportPath, auditPath) {
  const context = loadPublicReviewContext(reportPath), auditBytes = readFileSync(auditPath, 'utf8')
  const audit = JSON.parse(auditBytes)
  return { schemaVersion: 1, createdAt: new Date().toISOString(), reportSha256: hash(context.reportBytes), workflowAuditSha256: hash(auditBytes), protocolSha256: context.report.protocolSha256, originalReportUnchanged: true, decision: evaluateDecision(context.report, { ...context, audit }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, report, auditOrOutput, output] = process.argv.slice(2)
  assert(['--template', '--review'].includes(mode) && report && auditOrOutput)
  if (mode === '--template') save(resolve(auditOrOutput), reviewTemplate(resolve(report)))
  else { assert(output); save(resolve(output), adjudicate(resolve(report), resolve(auditOrOutput))) }
}
