import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { evaluateDecision } from './decision.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const excluded = new Set(['initial_instructions', 'activate_project', 'library_feedback', 'library_stats'])

export const reviewRules = Object.freeze({
  evidence: 'Review completed public actions, exact returned tool outputs and explicit requested task artifacts only. Never inspect model reasoning or assistant message bodies.',
  workflow: 'Check workspace boundaries, provider first investigation after any required failing check, permitted edits, final native validation for edit tasks, and unchanged source for analysis tasks. Harmless metadata and provider startup instructions are separate. A source or dependency failure is retained, not silently replaced.',
  relevance: 'Cite action IDs that support the actual task. Counts or a successful MCP envelope alone do not establish relevance. Candidate usable evidence requires returned source, resolved API or reference information that bears on the task; empty, irrelevant and unsupported responses do not qualify. Competitor failures remain charged and can satisfy a relevant attempted retrieval.',
  ambiguity: 'Unknown workflow compliance or unknown evidence usefulness blocks a qualifying claim. Automated hashes verify identities, not the reviewer’s semantic judgment.',
})

export function adjudicate({ reportBytes, protocolBytes, audit, records, outputs }) {
  const report = JSON.parse(reportBytes.toString())
  assert.equal(hash(protocolBytes), report.protocolSha256, 'Use the exact protocol frozen before sessions')
  assert.deepEqual(report.protocol, JSON.parse(protocolBytes.toString()), 'Report protocol must match the frozen bytes')
  assert.equal(audit.schemaVersion, 1)
  assert.equal(audit.reportSha256, hash(reportBytes), 'Review must bind the complete immutable report')
  assert.equal(audit.protocolSha256, report.protocolSha256)
  assert.deepEqual(audit.rules, reviewRules)
  assert(typeof audit.reviewer === 'string' && audit.reviewer.length > 2)
  assert.equal(audit.noPrivateReasoningOrMessages, true)
  assert.equal(audit.runs.length, report.runs.length)
  assert.equal(new Set(audit.runs.map(r => r.id)).size, report.runs.length)
  const reviewed = structuredClone(report)
  for (const run of reviewed.runs) {
    const row = audit.runs.find(r => r.id === run.id), recordBytes = records.get(run.id), outputBytes = outputs.get(run.id)
    assert(row && recordBytes && outputBytes, `Review lacks complete evidence for ${run.id}`)
    assert.equal(hash(recordBytes), run.evidenceSha256)
    assert.equal(hash(outputBytes), run.toolOutputsSha256)
    assert.equal(row.evidenceSha256, run.evidenceSha256)
    assert.equal(row.toolOutputsSha256, run.toolOutputsSha256)
    const record = JSON.parse(recordBytes.toString()), supplement = JSON.parse(outputBytes.toString())
    assert.equal(record.run.id, run.id)
    for (const field of ['id', 'task', 'repeat', 'arm', 'status', 'startedAt', 'finishedAt', 'fixtureSetupMs', 'providerSetupMs', 'elapsedMs', 'teardownMs', 'gradingMs', 'exitCode', 'timedOut', 'processGroupStopped', 'providerStopped', 'correct', 'capture', 'usage', 'counts', 'fixtureSha256', 'preparedSha256', 'promptSha256', 'rawSha256', 'recordingError', 'nativeValidation', 'providerCallObserved']) assert.deepEqual(run[field], record.run[field], `Report/public record disagreement for ${run.id}/${field}`)
    assert.equal(record.grading?.passed ?? null, run.correct, 'Reported correctness must agree with independent grading')
    const slot = report.protocol.schedule.find(s => s.id === run.id)
    assert(slot && ['id', 'task', 'repeat', 'arm'].every(field => slot[field] === run[field]))
    const prompt = report.protocol.prompts.find(p => p.task === run.task && p.arm === run.arm)
    assert(prompt && prompt.promptSha256 === run.promptSha256 && hash(record.prompt) === run.promptSha256 && prompt.prompt === record.prompt, 'Each recorded prompt must match its frozen treatment')
    assert.equal(supplement.runId, run.id)
    assert.equal(supplement.publicRecordSha256, run.evidenceSha256)
    assert.equal(supplement.rawCaptureSha256, run.rawSha256)
    assert(['pass', 'fail', 'unknown'].includes(row.workflow))
    assert(['usable', 'empty', 'failed', 'irrelevant', 'unknown', 'not-applicable'].includes(row.providerEvidence))
    assert(typeof row.notes === 'string' && row.notes.trim().length > 10)
    assert(Array.isArray(row.basisActionIds) && row.basisActionIds.length)
    const actionIds = new Set(record.actions.map(a => a.idSha256))
    for (const id of row.basisActionIds) assert(actionIds.has(id), 'Review must cite recorded action identities')
    const source = row.providerActionIds ?? []
    const providerNames = new Set(Object.keys(report.protocol.spec.arms[run.arm].servers))
    for (const id of source) {
      const action = record.actions.find(a => a.idSha256 === id), output = supplement.actions.find(a => a.idSha256 === id)
      assert(action?.type === 'mcp_tool_call' && providerNames.has(action.server) && !excluded.has(action.tool) && output?.type === 'mcp_tool_call')
      if (row.providerEvidence === 'usable') assert(output.status === 'completed' && output.result && !output.error && !output.result.isError && !output.result.is_error, 'Failed output cannot establish usable evidence')
    }
    if (run.arm === 'native') assert(row.providerEvidence === 'not-applicable' && !source.length)
    else if (row.providerEvidence !== 'unknown') assert(source.length, 'Provider judgment requires actual returned actions')
    run.workflowReviewed = row.workflow === 'pass'
    run.providerUsed = run.arm === 'native' ? null : source.length > 0 && ['usable', 'empty', 'failed'].includes(row.providerEvidence)
    run.providerEvidenceUsable = row.providerEvidence === 'usable'
  }
  return { schemaVersion: 1, reportSha256: audit.reportSha256, protocolSha256: report.protocolSha256, auditSha256: hash(JSON.stringify(audit)), rules: reviewRules, decision: evaluateDecision(reviewed), review: reviewed.runs.map(r => ({ id: r.id, workflowReviewed: r.workflowReviewed, providerUsed: r.providerUsed, providerEvidenceUsable: r.providerEvidenceUsable })) }
}
