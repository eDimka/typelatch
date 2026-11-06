import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifySearchCommand, extractPairedEvents, summarizePairedRuns } from './paired-agent-evidence.mjs'

const encode = rows => rows.map(row => JSON.stringify(row)).join('\n')
const start = { type: 'turn.started' }
const finish = usage => ({ type: 'turn.completed', usage })
const usage = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20, reasoning_output_tokens: 10 }
const command = (id, value) => ({ type: 'item.completed', item: { id, type: 'command_execution', command: value, aggregated_output: 'PUBLIC OUTPUT', exit_code: 0, status: 'completed' } })

test('retains terminal usage once and treats cached and reasoning tokens as components', () => {
  const value = extractPairedEvents(encode([start, finish(usage), finish(usage)]))
  assert.equal(value.capture.complete, true)
  assert.equal(value.capture.duplicateCompletions, 1)
  assert.deepEqual(value.usage, { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: null, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 120, uncachedInputTokens: 40 })
})

test('unknown usage stays null and conflicting terminal usage does not qualify', () => {
  const missing = extractPairedEvents(encode([start, finish({ output_tokens: 20 })]))
  assert.equal(missing.usage.inputTokens, null)
  assert.equal(missing.usage.totalTokens, null)
  assert.equal(missing.capture.complete, false)
  const conflict = extractPairedEvents(encode([start, finish(usage), finish({ ...usage, input_tokens: 101 })]))
  assert.equal(conflict.capture.complete, false)
  assert.equal(conflict.usage.inputTokens, null)
})

test('invalid component values and totals are rejected instead of silently added', () => {
  for (const invalid of [{ ...usage, cached_input_tokens: 101 }, { ...usage, reasoning_output_tokens: 21 }, { ...usage, total_tokens: 200 }]) {
    const value = extractPairedEvents(encode([start, finish(invalid)]))
    assert.equal(value.capture.complete, false)
    assert(value.capture.issues.some(issue => issue.code === 'inconsistent-usage'))
  }
})

test('public action projection excludes messages, reasoning and unrecognized fields', () => {
  const value = extractPairedEvents(encode([
    start,
    { type: 'item.completed', item: { id: 'reason', type: 'reasoning', text: 'PRIVATE_REASONING' } },
    { type: 'item.completed', item: { id: 'message', type: 'agent_message', text: 'PRIVATE_MESSAGE' } },
    { ...command('command', 'rg rollback src'), private_prompt: 'PRIVATE_PROMPT' },
    { type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', server: 'typelatch', tool: 'workspace_search', arguments: { question: 'rollback' }, result: { content: [{ type: 'text', text: 'PUBLIC_RESULT' }], private_analysis: 'PRIVATE_REASONING' }, private_analysis: 'PRIVATE_REASONING', status: 'completed' } },
    finish(usage),
  ]))
  assert.equal(value.actions.length, 2)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|"reasoning"|"agent_message"/)
  assert.doesNotMatch(JSON.stringify(value), /PUBLIC OUTPUT|PUBLIC_RESULT/)
  assert.equal(value.actions[0].outputBytes, 13)
  assert.equal(value.actions[1].resultSha256.length, 64)
  assert.equal(value.counts.mcpSucceeded, 1)
  assert.equal(value.counts.grepShellCalls, 1)
})

test('duplicate completed action identifiers are counted once; conflicts are flagged', () => {
  const item = command('a', 'rg --files')
  const value = extractPairedEvents(encode([start, item, item, finish(usage)]))
  assert.equal(value.capture.complete, true)
  assert.equal(value.capture.duplicateActions, 1)
  assert.equal(value.counts.shellCalls, 1)
  const conflict = extractPairedEvents(encode([start, item, command('a', 'grep one file'), finish(usage)]))
  assert.equal(conflict.capture.complete, false)
})

test('failed and unfinished sessions retain observed actions without claiming complete measurement', () => {
  const value = extractPairedEvents(encode([start, command('a', 'rg x'), { type: 'item.started', item: { id: 'pending', type: 'command_execution' } }, { type: 'turn.failed', error: { message: 'PRIVATE_ERROR' } }]))
  assert.equal(value.capture.complete, false)
  assert.equal(value.capture.failedTurn, true)
  assert.equal(value.counts.shellCalls, 1)
  assert.equal(value.usage.totalTokens, null)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_ERROR/)
})

test('MCP error envelopes and missing results are unsuccessful calls', () => {
  const events = [{ status: 'failed', error: { message: 'denied' } }, { status: 'completed', result: { isError: true, content: [] } }, { status: 'completed' }].map((item, i) => ({ type: 'item.completed', item: { id: String(i), type: 'mcp_tool_call', server: 'typelatch', tool: 'workspace_search', ...item } }))
  const value = extractPairedEvents(encode([start, ...events, finish(usage)]))
  assert.equal(value.counts.mcpCalls, 3)
  assert.equal(value.counts.mcpFailed, 3)
  assert.equal(value.counts.mcpSucceeded, 0)
})

test('known Codex startup feature warnings are metadata, while other error items remain incomplete', () => {
  const warning = { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'Under-development features enabled: skip_host_skill_discovery. PRIVATE_LOCAL_CONFIG_PATH' } }
  const value = extractPairedEvents(encode([warning, start, finish(usage)]))
  assert.equal(value.capture.complete, true)
  assert.equal(value.capture.startupWarnings.length, 1)
  assert.equal(value.capture.startupWarnings[0].messageSha256.length, 64)
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE_LOCAL_CONFIG_PATH/)
  assert.equal(extractPairedEvents(encode([start, warning, finish(usage)])).capture.complete, false)
  assert.equal(extractPairedEvents(encode([{ ...warning, item: { ...warning.item, message: 'Unknown fatal infrastructure error' } }, start, finish(usage)])).capture.complete, false)
})

test('counts shell call groups separately from content search and file listing', () => {
  assert.deepEqual(classifySearchCommand('rg --files && rg -n "transaction" src | grep -v test'), { search: true, contentSearch: true, fileListing: true, ambiguous: false })
  assert.deepEqual(classifySearchCommand('/opt/homebrew/bin/rg --files -g "*.ts"'), { search: true, contentSearch: false, fileListing: true, ambiguous: false })
  assert.equal(classifySearchCommand('grep -rl "timeout" src').contentSearch, true)
})

test('unwraps normal shell launchers and command prefixes', () => {
  assert.equal(classifySearchCommand('/bin/zsh -lc \'pwd; rg -n "retry" src\'').contentSearch, true)
  assert.equal(classifySearchCommand('bash -c "rg --files"').fileListing, true)
  assert.equal(classifySearchCommand('FOO=1 command rg --files').fileListing, true)
  assert.equal(classifySearchCommand('env LANG=C /usr/bin/grep timeout x').contentSearch, true)
})

test('literal mentions, comments and heredoc program text are not search commands', () => {
  for (const source of ['echo grep', 'printf "%s" "rg --files"', 'cat grep.txt', '# rg test\ncat src/a.ts', "python3 - <<'PY'\nprint('rg rollback src')\nPY\ncat src/a.ts", "cat <<EOF\ngrep x y\nEOF"]) {
    assert.deepEqual(classifySearchCommand(source), { search: false, contentSearch: false, fileListing: false, ambiguous: false }, source)
  }
})

test('quoted patterns resembling file listing flags remain content searches', () => {
  assert.equal(classifySearchCommand("rg -e '--files' src").contentSearch, true)
  assert.equal(classifySearchCommand("rg -- '--files' src").contentSearch, true)
  assert.equal(classifySearchCommand("rg -g '*.ts' --files").fileListing, true)
})

test('dynamic evaluation is marked uncertain rather than reported as exact search execution', () => {
  assert.equal(classifySearchCommand('echo "$(rg thing src)"').ambiguous, true)
  assert.equal(classifySearchCommand('eval "rg x src"').ambiguous, true)
  assert.equal(classifySearchCommand('find src -type f -exec grep token {} \\;').ambiguous, true)
})

const run = (arm, overrides = {}) => ({ id: arm, task: 'rollback', repeat: 1, arm, correct: true, elapsedMs: arm === 'baseline' ? 2000 : 1000, usage: { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, totalTokens: 120 }, counts: { shellCalls: 2, mcpCalls: 0, grepShellCalls: arm === 'baseline' ? 2 : 0 }, ...overrides })

test('paired aggregation includes incorrect runs and uses typelatch minus baseline deltas', () => {
  const summary = summarizePairedRuns([run('baseline'), run('typelatch', { correct: false })])
  assert.equal(summary.arms.typelatch.runs, 1)
  assert.equal(summary.arms.typelatch.incorrect, 1)
  assert.equal(summary.arms.typelatch.metrics.elapsedMs.sum, 1000)
  assert.equal(summary.pairs[0].bothCorrect, false)
  assert.deepEqual(summary.pairs[0].metrics.elapsedMs, { baseline: 2000, typelatch: 1000, delta: -1000, percentChange: -50 })
  assert.equal(summary.pairs[0].metrics.mcpCalls.percentChange, null)
})

test('unknown and incomplete capture metrics never become zero or complete totals', () => {
  const summary = summarizePairedRuns([run('baseline'), run('typelatch', { correct: null, elapsedMs: null, usage: null, capture: { complete: false } })])
  assert.equal(summary.arms.typelatch.unknownCorrectness, 1)
  assert.equal(summary.arms.typelatch.metrics.totalTokens.sum, null)
  assert.equal(summary.arms.typelatch.metrics.grepShellCalls.sum, null)
  assert.equal(summary.pairs[0].metrics.elapsedMs.delta, null)
  const incomplete = summarizePairedRuns([run('baseline'), run('baseline', { id: 'b2', repeat: 2, elapsedMs: null })])
  assert.equal(incomplete.arms.baseline.metrics.elapsedMs.observedSum, 2000)
  assert.equal(incomplete.arms.baseline.metrics.elapsedMs.sum, null)
  assert.equal(incomplete.pairs[0].complete, false)
})

test('duplicate task repeat arm identities are rejected to prevent double counting', () => {
  assert.throws(() => summarizePairedRuns([run('baseline'), run('baseline', { id: 'duplicate' })]), /Duplicate/)
})
