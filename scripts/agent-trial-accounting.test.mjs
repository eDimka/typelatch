import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractAccounting } from './agent-trial-accounting.mjs'

const usage = { input_tokens: 100, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110 }
const record = (type, payload) => ({ timestamp: '2026-10-06T00:00:00.000Z', type, payload })
const response = record('token_usage_record', { thread_id: 'agent-thread', turn_id: 'coding', response_id: 'response-one', usage, turn_token_usage: usage })
const fixture = () => [
  record('session_meta', { id: 'agent-thread', cli_version: 'test', model_provider: 'provider', source: { subagent: { thread_spawn: { parent_thread_id: 'root-thread', agent_path: '/root/pilot' } } }, private_metadata: 'PRIVATE_METADATA' }),
  record('event_msg', { type: 'task_started', turn_id: 'coding' }),
  record('turn_context', { turn_id: 'coding', model: 'test-model', effort: 'test-effort', developer_instructions: 'PRIVATE_INSTRUCTIONS' }),
  record('response_item', { type: 'reasoning', content: 'PRIVATE_REASONING' }),
  record('response_item', { type: 'message', content: 'PRIVATE_MESSAGE' }),
  record('response_item', { type: 'custom_tool_call', call_id: 'tool-one', name: 'exec', input: 'PRIVATE_COMMAND' }),
  record('response_item', { type: 'custom_tool_call_output', call_id: 'tool-one', output: 'PRIVATE_OUTPUT' }),
  response,
  record('event_msg', { type: 'token_count', info: { total_token_usage: usage } }),
  record('event_msg', { type: 'token_count', info: { total_token_usage: usage } }),
  record('event_msg', { type: 'task_complete', turn_id: 'coding', duration_ms: 1000, last_agent_message: 'PRIVATE_FINAL' }),
  record('event_msg', { type: 'task_started', turn_id: 'review' }),
  record('token_usage_record', { thread_id: 'agent-thread', turn_id: 'review', response_id: 'later-response', usage, turn_token_usage: usage }),
  record('event_msg', { type: 'task_complete', turn_id: 'review' })
]
function withRollout(records, run) {
  const root = mkdtempSync(join(tmpdir(), 'typelatch-accounting-'))
  const rollout = join(root, 'rollout.jsonl')
  writeFileSync(rollout, records.map(value => JSON.stringify(value)).join('\n') + '\n')
  try { return run({ rollout, rootThreadId: 'root-thread', agentPath: '/root/pilot' }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

test('exports only metadata, reconciles usage, excludes later work and repeated cumulative events', () => {
  withRollout(fixture(), options => {
    const result = extractAccounting(options)
    assert.equal(result.accounting.status, 'recorded-and-reconciled')
    assert.deepEqual(result.accounting.totals, usage)
    assert.equal(result.accounting.responseCount, 1)
    assert.equal(result.accounting.cumulativeTokenCountEventsIgnored, 2)
    assert.equal(result.settings.model, 'test-model')
    assert.equal(result.settings.reasoningEffort, 'test-effort')
    assert.equal(result.settings.modelSnapshot, null)
    assert.equal(result.toolEvents.length, 2)
    assert.equal(result.segment.firstLine, 2)
    assert.equal(result.segment.lastLine, 11)
    assert(!JSON.stringify(result).includes('PRIVATE_'))
    assert.equal(readFileSync(options.rollout, 'utf8').split('\n').length, 15)
  })
})

test('deduplicates repeated per-response usage without inflating totals', () => {
  const rows = fixture(); rows.splice(8, 0, response)
  withRollout(rows, options => {
    const result = extractAccounting(options)
    assert.equal(result.accounting.duplicateUsageRecordsExcluded, 1)
    assert.deepEqual(result.accounting.totals, usage)
  })
})

test('rejects conflicting duplicated usage', () => {
  const rows = fixture(); rows.splice(8, 0, { ...response, payload: { ...response.payload, usage: { ...usage, input_tokens: 101 } } })
  withRollout(rows, options => assert.throws(() => extractAccounting(options), /Conflicting usage/))
})

test('does not infer missing model settings, reasoning tokens or billing values', () => {
  const rows = fixture().filter(row => row.type !== 'turn_context')
  rows[6] = { ...response, payload: { ...response.payload, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }
  withRollout(rows, options => {
    const result = extractAccounting(options)
    assert.equal(result.settings.model, null)
    assert.equal(result.settings.reasoningEffort, null)
    assert.equal(result.accounting.totals.reasoning_output_tokens, null)
    assert.equal(result.accounting.monetaryCost, null)
    assert.equal(result.accounting.status, 'partial-or-inconsistent')
  })
})

test('rejects a different root or agent and requires completed turn evidence', () => {
  withRollout(fixture(), options => {
    assert.throws(() => extractAccounting({ ...options, rootThreadId: 'other' }), /different root/)
    assert.throws(() => extractAccounting({ ...options, agentPath: '/root/other' }), /different agent/)
  })
  withRollout(fixture().filter(row => !(row.type === 'event_msg' && row.payload.type === 'task_complete' && row.payload.turn_id === 'coding')), options => assert.throws(() => extractAccounting(options), /terminal task_complete/))
})

test('an explicit later turn accounts for that turn only', () => {
  withRollout(fixture(), options => {
    const result = extractAccounting({ ...options, turnId: 'review' })
    assert.equal(result.source.turnId, 'review')
    assert.equal(result.toolEvents.length, 0)
    assert.equal(result.settings.model, null)
    assert.deepEqual(result.accounting.totals, usage)
  })
})

test('missing usage remains unknown even when cumulative UI events exist', () => {
  withRollout(fixture().filter(row => row.type !== 'token_usage_record'), options => {
    const result = extractAccounting(options)
    assert.equal(result.accounting.status, 'unknown')
    assert.equal(result.accounting.totals.total_tokens, null)
  })
})

test('detects inconsistent cumulative accounting rather than silently accepting totals', () => {
  const rows = fixture(); rows[7] = { ...response, payload: { ...response.payload, turn_token_usage: { ...usage, total_tokens: 999 } } }
  withRollout(rows, options => {
    const result = extractAccounting(options)
    assert.equal(result.accounting.status, 'partial-or-inconsistent')
    assert.equal(result.accounting.cumulativeChecks[0].matches.total_tokens, false)
  })
})
