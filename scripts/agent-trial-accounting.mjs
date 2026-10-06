import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens']
const hash = value => createHash('sha256').update(value).digest('hex')
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key] ?? null]))
const safeUsage = value => Object.fromEntries(fields.map(key => [key, Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : null]))

// Only allowlisted metadata leaves this reader. Never serialize a rollout payload.
export function extractAccounting({ rollout, rootThreadId, agentPath, turnId = 'initial' }) {
  assert(typeof rollout === 'string' && rootThreadId && agentPath, 'Explicit rollout, root thread and agent are required')
  const bytes = readFileSync(rollout)
  const lines = bytes.toString('utf8').split(/(?<=\n)/u).filter(Boolean)
  let offset = 0
  const records = lines.map((line, index) => {
    const record = JSON.parse(line)
    const result = { record, line: index + 1, offset, bytes: Buffer.byteLength(line), sha256: hash(line) }
    offset += result.bytes
    return result
  })
  const metaRecords = records.filter(({ record }) => record.type === 'session_meta')
  assert.equal(metaRecords.length, 1, 'Exactly one session metadata record is required')
  const meta = metaRecords[0].record.payload
  const spawn = meta.source?.subagent?.thread_spawn
  assert.equal(spawn?.parent_thread_id, rootThreadId, 'Rollout belongs to a different root thread')
  assert.equal(spawn?.agent_path, agentPath, 'Rollout belongs to a different agent')
  const starts = records.filter(({ record }) => record.type === 'event_msg' && record.payload?.type === 'task_started')
  assert(starts.length, 'No task start exists')
  const selectedId = turnId === 'initial' ? starts[0].record.payload.turn_id : turnId
  const selectedStarts = starts.filter(({ record }) => record.payload.turn_id === selectedId)
  const completions = records.filter(({ record }) => record.type === 'event_msg' && record.payload?.type === 'task_complete' && record.payload.turn_id === selectedId)
  assert.equal(selectedStarts.length, 1, 'Exactly one matching task start is required')
  assert.equal(completions.length, 1, 'A terminal task_complete record is required')
  const start = selectedStarts[0]
  const end = completions[0]
  assert(end.line > start.line, 'Task completion precedes task start')
  const selected = records.filter(entry => entry.line >= start.line && entry.line <= end.line)
  const contexts = records.filter(({ record, line }) => record.type === 'turn_context' && record.payload?.turn_id === selectedId && line <= end.line)
    .map(entry => ({ line: entry.line, sha256: entry.sha256, ...pick(entry.record.payload, ['model', 'effort', 'reasoning_effort']) }))
  const consistent = key => contexts.length && contexts.every(context => context[key] === contexts[0][key]) ? contexts[0][key] : null
  const usages = []
  const seen = new Map()
  let duplicates = 0
  for (const entry of selected) {
    const { record } = entry
    if (record.type !== 'token_usage_record' || record.payload?.turn_id !== selectedId) continue
    const payload = record.payload
    assert.equal(payload.thread_id, meta.id, 'Usage belongs to another thread')
    assert(typeof payload.response_id === 'string' && payload.response_id, 'Usage needs a response identifier for deduplication')
    const usage = safeUsage(payload.usage)
    const prior = seen.get(payload.response_id)
    if (prior) {
      assert.deepEqual(prior, usage, 'Conflicting usage for one response identifier')
      duplicates++
      continue
    }
    seen.set(payload.response_id, usage)
    usages.push({ line: entry.line, sha256: entry.sha256, at: record.timestamp ?? null, responseIdSha256: hash(payload.response_id), usage, reportedTurnTotal: safeUsage(payload.turn_token_usage) })
  }
  const totals = Object.fromEntries(fields.map(key => [key, usages.length && usages.every(item => item.usage[key] !== null) ? usages.reduce((sum, item) => sum + item.usage[key], 0) : null]))
  const finalRecordedTotal = usages.at(-1)?.reportedTurnTotal ?? Object.fromEntries(fields.map(key => [key, null]))
  const cumulativeChecks = usages.map((item, index) => ({
    line: item.line,
    matches: Object.fromEntries(fields.map(key => [key, item.reportedTurnTotal[key] === null || usages.slice(0, index + 1).some(row => row.usage[key] === null) ? null : usages.slice(0, index + 1).reduce((sum, row) => sum + row.usage[key], 0) === item.reportedTurnTotal[key]]))
  }))
  const toolEvents = selected.filter(({ record }) => record.type === 'response_item' && ['function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'].includes(record.payload?.type))
    .map(entry => ({ line: entry.line, sha256: entry.sha256, at: entry.record.timestamp ?? null, type: entry.record.payload.type, name: entry.record.payload.name ?? null, callIdSha256: typeof entry.record.payload.call_id === 'string' ? hash(entry.record.payload.call_id) : null }))
  const endPayload = end.record.payload
  const segmentEnd = end.offset + end.bytes
  return {
    schemaVersion: 1,
    kind: 'Allowlisted local Codex trial metadata',
    source: { filename: basename(rollout), sha256: hash(bytes), bytes: bytes.length, rootThreadId, agentPath, threadId: meta.id, turnId: selectedId },
    segment: { firstLine: start.line, lastLine: end.line, byteStart: start.offset, byteEndExclusive: segmentEnd, sha256: hash(bytes.subarray(start.offset, segmentEnd)), startedAt: start.record.timestamp ?? null, completedAt: end.record.timestamp ?? null, durationMs: Number.isFinite(endPayload.duration_ms) ? endPayload.duration_ms : null },
    settings: { model: consistent('model'), reasoningEffort: consistent('effort'), alternateReasoningEffort: consistent('reasoning_effort'), modelProvider: meta.model_provider ?? null, clientVersion: meta.cli_version ?? null, originator: meta.originator ?? null, modelSnapshot: null, seed: null, contexts },
    accounting: { status: usages.length ? (fields.every(key => totals[key] !== null) && cumulativeChecks.every(check => Object.values(check.matches).every(value => value === true)) ? 'recorded-and-reconciled' : 'partial-or-inconsistent') : 'unknown', responseCount: usages.length, duplicateUsageRecordsExcluded: duplicates, cumulativeTokenCountEventsIgnored: selected.filter(({ record }) => record.type === 'event_msg' && record.payload?.type === 'token_count').length, totals, finalRecordedTotal, cumulativeChecks, responses: usages, monetaryCost: null, billingReconciliation: 'not-observed' },
    toolEvents,
    privacy: { reasoningContentExported: false, messageBodiesExported: false, internalPromptsExported: false, toolArgumentsExported: false, toolOutputsExported: false, sourceRolloutCopied: false },
    limits: [
      'Local client metadata records observed usage; it is not an independently signed provider bill.',
      'Input totals count every model request, including repeated context and cached tokens. They are not unique prompt size.',
      'Cached input and reasoning output are component fields and must not be added to input and output totals.',
      'This extract has no complete public model prompt or authoritative server model snapshot, seed, or monetary charge.',
      'Tool event hashes do not establish operating system isolation or exclude unlogged file access.',
      'The source digest covers a current local rollout. The segment digest remains stable if later turns are appended.'
    ]
  }
}

function main(args) {
  const options = {}
  const names = { '--rollout': 'rollout', '--root-thread': 'rootThreadId', '--agent': 'agentPath', '--turn': 'turnId', '--output': 'output' }
  for (let i = 0; i < args.length; i += 2) {
    assert(names[args[i]] && args[i + 1], 'Usage: node scripts/agent-trial-accounting.mjs --rollout PATH --root-thread ID --agent /root/NAME --turn initial|ID [--output PATH]')
    assert(!Object.hasOwn(options, names[args[i]]), 'Duplicate option')
    options[names[args[i]]] = args[i + 1]
  }
  const result = extractAccounting(options)
  const json = JSON.stringify(result, null, 2) + '\n'
  if (options.output) writeFileSync(options.output, json)
  else process.stdout.write(json)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2))
