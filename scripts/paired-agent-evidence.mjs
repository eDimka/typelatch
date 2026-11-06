import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const usageNames = {
  inputTokens: 'input_tokens', cachedInputTokens: 'cached_input_tokens', cacheWriteInputTokens: 'cache_write_input_tokens',
  outputTokens: 'output_tokens', reasoningOutputTokens: 'reasoning_output_tokens',
}
const emptyUsage = () => Object.fromEntries([...Object.keys(usageNames), 'totalTokens', 'uncachedInputTokens'].map(key => [key, null]))
const actionTypes = new Set(['command_execution', 'mcp_tool_call', 'file_change'])
const ignoredItemTypes = new Set(['reasoning', 'agent_message', 'todo_list'])
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

function readUsage(raw) {
  const result = Object.fromEntries(Object.entries(usageNames).map(([key, native]) => [key, number(raw?.[native])]))
  result.totalTokens = result.inputTokens === null || result.outputTokens === null ? null : result.inputTokens + result.outputTokens
  result.uncachedInputTokens = result.inputTokens === null || result.cachedInputTokens === null ? null : result.inputTokens - result.cachedInputTokens
  const invalid = (result.cachedInputTokens !== null && result.inputTokens !== null && result.cachedInputTokens > result.inputTokens)
    || (result.cacheWriteInputTokens !== null && result.inputTokens !== null && result.cacheWriteInputTokens > result.inputTokens)
    || (result.reasoningOutputTokens !== null && result.outputTokens !== null && result.reasoningOutputTokens > result.outputTokens)
    || (raw?.total_tokens !== undefined && (number(raw.total_tokens) === null || raw.total_tokens !== result.totalTokens))
    || Object.values(usageNames).some(key => raw?.[key] !== undefined && number(raw[key]) === null)
  return { value: invalid ? emptyUsage() : result, invalid }
}

// This lexer recognizes common direct shell invocations, not operating system process execution.
function shellTokens(source) {
  const tokens = []
  const heredocs = []
  let delimiter = null
  let uncertain = false
  let i = 0
  while (i < source.length) {
    if (source[i] === '\n') {
      tokens.push({ operator: '\n' }); i++
      for (const document of heredocs.splice(0)) {
        let closed = false
        while (i < source.length) {
          const end = source.indexOf('\n', i)
          const lineEnd = end < 0 ? source.length : end
          const line = source.slice(i, lineEnd)
          i = end < 0 ? source.length : end + 1
          if ((document.tabs ? line.replace(/^\t+/, '') : line) === document.value) { closed = true; break }
        }
        if (!closed) uncertain = true
      }
      continue
    }
    if (/\s/u.test(source[i])) { i++; continue }
    if (source[i] === '#') { while (i < source.length && source[i] !== '\n') i++; continue }
    const operator = source.slice(i).match(/^(?:<<-|<<|&&|\|\||[;&|()<>])/u)?.[0]
    if (operator) {
      tokens.push({ operator }); i += operator.length
      if (operator === '<<' || operator === '<<-') delimiter = { tabs: operator === '<<-' }
      continue
    }
    let value = '', quote = null, dynamic = false
    while (i < source.length) {
      const char = source[i]
      if (!quote && (/\s/u.test(char) || /[;&|()<>]/u.test(char))) break
      if (!quote && (char === '"' || char === "'")) { quote = char; i++; continue }
      if (quote && char === quote) { quote = null; i++; continue }
      if (char === '\\' && quote !== "'" && i + 1 < source.length) {
        const next = source[i + 1]
        if (next !== '\n') value += next
        i += 2; continue
      }
      if (quote !== "'" && (char === '`' || source.slice(i, i + 2) === '$(')) dynamic = true
      value += char; i++
    }
    if (quote) uncertain = true
    tokens.push({ value, dynamic })
    if (delimiter) { heredocs.push({ ...delimiter, value }); delimiter = null }
  }
  if (heredocs.length || delimiter) uncertain = true
  return { tokens, uncertain }
}

const basename = value => String(value ?? '').split('/').at(-1)
const searchName = value => ['rg', 'grep', 'egrep', 'fgrep'].includes(basename(value))
const mentionSearch = source => /(?:^|[^\w])(?:rg|grep|egrep|fgrep)(?:[^\w]|$)/u.test(source)

export function classifySearchCommand(source, depth = 0) {
  const result = { search: false, contentSearch: false, fileListing: false, ambiguous: false }
  if (typeof source !== 'string') return { ...result, ambiguous: true }
  if (depth > 4) return { ...result, ambiguous: true }
  const { tokens, uncertain } = shellTokens(source)
  result.ambiguous = uncertain
  const segments = [[]]
  for (const token of tokens) {
    if (token.operator && [';', '&&', '||', '|', '\n', '&', '(', ')'].includes(token.operator)) segments.push([])
    else segments.at(-1).push(token)
  }
  for (const segment of segments) {
    let words = segment.filter(token => !token.operator)
    if (!words.length) continue
    if (words.some(word => word.dynamic) && mentionSearch(source)) result.ambiguous = true
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0].value) || ['do', 'then', 'else', '!', 'if', 'elif'].includes(words[0].value))) words.shift()
    while (words.length && ['command', 'exec', 'env', 'time', 'nohup', 'sudo'].includes(basename(words[0].value))) {
      const prefix = basename(words.shift().value)
      while (words.length && (words[0].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0].value))) {
        const option = words.shift().value
        if (prefix === 'env' && ['-u', '--unset', '-C', '--chdir'].includes(option)) words.shift()
        if (prefix === 'sudo' && ['-u', '-g'].includes(option)) words.shift()
      }
    }
    if (!words.length) continue
    const name = basename(words[0].value)
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) {
      const commandOption = words.findIndex((word, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(word.value))
      if (commandOption >= 0 && words[commandOption + 1]) {
        const nested = classifySearchCommand(words[commandOption + 1].value, depth + 1)
        for (const key of Object.keys(result)) result[key] ||= nested[key]
      } else if (mentionSearch(words.slice(1).map(word => word.value).join(' '))) result.ambiguous = true
      continue
    }
    if (name === 'eval' || (['find', 'xargs'].includes(name) && words.some(word => searchName(word.value)))) {
      if (mentionSearch(words.slice(1).map(word => word.value).join(' '))) result.ambiguous = true
      continue
    }
    if (!searchName(name)) continue
    result.search = true
    let listing = false
    if (name === 'rg') {
      for (let index = 1; index < words.length; index++) {
        const value = words[index].value
        if (value === '--') break
        if (['-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--type-add', '--type-clear', '--encoding', '--max-count', '-m', '--max-depth'].includes(value)) { index++; continue }
        if (value === '--files') listing = true
      }
    }
    result.fileListing ||= listing
    result.contentSearch ||= !listing
  }
  return result
}

function publicAction(item) {
  const base = { type: item.type, idSha256: typeof item.id === 'string' ? hash(item.id) : null, status: typeof item.status === 'string' ? item.status : null }
  if (item.type === 'command_execution') return {
    ...base, command: typeof item.command === 'string' ? item.command : null,
    outputBytes: typeof item.aggregated_output === 'string' ? Buffer.byteLength(item.aggregated_output) : null,
    outputSha256: typeof item.aggregated_output === 'string' ? hash(item.aggregated_output) : null,
    exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
  }
  if (item.type === 'file_change') return { ...base, changes: Array.isArray(item.changes) ? item.changes.map(change => ({ path: typeof change?.path === 'string' ? change.path : null, kind: typeof change?.kind === 'string' ? change.kind : null, ...(typeof change?.diff === 'string' ? { diffSha256: hash(change.diff) } : {}) })) : [] }
  const result = item.result
  const resultJson = result == null ? null : JSON.stringify(result)
  return {
    ...base, server: typeof item.server === 'string' ? item.server : null, tool: typeof item.tool === 'string' ? item.tool : null,
    arguments: item.arguments ?? null, hasError: item.error != null, hasResult: result != null,
    resultBytes: resultJson === null ? null : Buffer.byteLength(resultJson),
    resultSha256: resultJson === null ? null : hash(resultJson),
    result: result == null ? null : { isError: result.isError === true || result.is_error === true },
  }
}

export function extractPairedEvents(jsonl) {
  assert.equal(typeof jsonl, 'string', 'Codex event stream must be text')
  const actions = [], issues = [], startupWarnings = [], completedIds = new Map(), pendingIds = new Set()
  let turnStarts = 0, turnCompletions = 0, duplicateActions = 0, duplicateCompletions = 0, failedTurn = false, usage = null, conflictingUsage = false
  for (const [index, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { issues.push({ code: 'invalid-json', line: index + 1 }); continue }
    if (row?.type === 'turn.started') { turnStarts++; continue }
    if (row?.type === 'turn.failed' || row?.type === 'error') { failedTurn = true; continue }
    if (row?.type === 'turn.completed') {
      turnCompletions++
      const next = readUsage(row.usage)
      if (next.invalid) issues.push({ code: 'inconsistent-usage', line: index + 1 })
      if (usage === null) usage = next.value
      else if (canonical(usage) === canonical(next.value)) duplicateCompletions++
      else { conflictingUsage = true; issues.push({ code: 'conflicting-terminal-usage', line: index + 1 }) }
      continue
    }
    if (!row?.type?.startsWith('item.') || !row.item) continue
    const item = row.item
    if (row.type === 'item.started' && actionTypes.has(item.type) && typeof item.id === 'string') pendingIds.add(item.id)
    if (row.type !== 'item.completed') continue
    if (ignoredItemTypes.has(item.type)) continue
    if (item.type === 'error' && turnStarts === 0 && typeof item.message === 'string' && item.message.startsWith('Under-development features enabled:')) {
      startupWarnings.push({ line: index + 1, kind: 'unstable-features', messageSha256: hash(item.message) })
      continue
    }
    if (!actionTypes.has(item.type)) { issues.push({ code: 'unrecognized-completed-item', line: index + 1 }); continue }
    const action = publicAction(item)
    if (!action.idSha256) issues.push({ code: 'action-without-id', line: index + 1 })
    else if (completedIds.has(action.idSha256)) {
      duplicateActions++
      if (completedIds.get(action.idSha256) !== canonical(action)) issues.push({ code: 'conflicting-completed-action', line: index + 1 })
      continue
    }
    if (action.idSha256) completedIds.set(action.idSha256, canonical(action))
    pendingIds.delete(item.id)
    if (item.type === 'command_execution') action.search = classifySearchCommand(action.command)
    actions.push(action)
  }
  if (turnStarts !== 1) issues.push({ code: 'expected-one-turn-start', observed: turnStarts })
  if (!turnCompletions) issues.push({ code: 'missing-turn-completion' })
  if (pendingIds.size) issues.push({ code: 'unfinished-actions', observed: pendingIds.size })
  if (conflictingUsage) usage = null
  usage ??= emptyUsage()
  if (usage.inputTokens === null || usage.outputTokens === null) issues.push({ code: 'missing-required-usage' })
  const commands = actions.filter(action => action.type === 'command_execution')
  const calls = actions.filter(action => action.type === 'mcp_tool_call')
  const succeeded = calls.filter(action => action.status === 'completed' && action.hasResult && !action.hasError && !action.result?.isError).length
  return {
    actions, usage,
    counts: {
      shellCalls: commands.length, mcpCalls: calls.length, mcpSucceeded: succeeded, mcpFailed: calls.length - succeeded,
      fileEdits: actions.filter(action => action.type === 'file_change').length,
      grepShellCalls: commands.filter(action => action.search.search).length,
      contentSearchShellCalls: commands.filter(action => action.search.contentSearch).length,
      fileListingShellCalls: commands.filter(action => action.search.fileListing).length,
      ambiguousSearchShellCalls: commands.filter(action => action.search.ambiguous).length,
    },
    capture: { complete: issues.length === 0 && !failedTurn, issues, startupWarnings, turnStarts, turnCompletions, duplicateActions, duplicateCompletions, failedTurn },
  }
}

const countNames = ['shellCalls', 'mcpCalls', 'mcpSucceeded', 'mcpFailed', 'fileEdits', 'grepShellCalls', 'contentSearchShellCalls', 'fileListingShellCalls', 'ambiguousSearchShellCalls']
const metricNames = ['elapsedMs', ...Object.keys(emptyUsage()), ...countNames]
const metric = (run, name) => {
  if (!run) return null
  if (countNames.includes(name) && run.capture?.complete === false) return null
  const value = name === 'elapsedMs' ? run.elapsedMs : countNames.includes(name) ? run.counts?.[name] : run.usage?.[name]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function stats(values) {
  const known = values.filter(value => value !== null).sort((a, b) => a - b)
  const observedSum = known.length ? known.reduce((sum, value) => sum + value, 0) : null
  const complete = known.length > 0 && known.length === values.length
  const middle = Math.floor(known.length / 2)
  return {
    n: known.length, missing: values.length - known.length,
    sum: complete ? observedSum : null, observedSum,
    mean: complete ? observedSum / known.length : null,
    median: complete ? known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2 : null,
    min: complete ? known[0] : null, max: complete ? known.at(-1) : null,
  }
}

export function summarizePairedRuns(runs) {
  assert(Array.isArray(runs), 'Runs must be an array')
  const grouped = new Map(), ids = new Set()
  for (const run of runs) {
    assert(['baseline', 'typelatch'].includes(run.arm), 'Unknown benchmark arm')
    assert(typeof run.id === 'string' && run.id && !ids.has(run.id), 'Duplicate or missing run identifier')
    ids.add(run.id)
    assert(typeof run.task === 'string' && run.task && Number.isInteger(run.repeat) && run.repeat > 0, 'A task and positive repeat are required')
    const key = JSON.stringify([run.task, run.repeat])
    if (!grouped.has(key)) grouped.set(key, { task: run.task, repeat: run.repeat })
    assert(!grouped.get(key)[run.arm], 'Duplicate task repeat arm')
    grouped.get(key)[run.arm] = run
  }
  const arms = Object.fromEntries(['baseline', 'typelatch'].map(arm => {
    const selected = runs.filter(run => run.arm === arm)
    return [arm, {
      runs: selected.length, correct: selected.filter(run => run.correct === true).length, incorrect: selected.filter(run => run.correct === false).length,
      unknownCorrectness: selected.filter(run => run.correct !== true && run.correct !== false).length,
      metrics: Object.fromEntries(metricNames.map(name => [name, stats(selected.map(run => metric(run, name)))])),
    }]
  }))
  const pairs = [...grouped.values()].map(pair => ({
    task: pair.task, repeat: pair.repeat, baselineId: pair.baseline?.id ?? null, typelatchId: pair.typelatch?.id ?? null,
    complete: Boolean(pair.baseline && pair.typelatch),
    bothCorrect: pair.baseline?.correct === true && pair.typelatch?.correct === true,
    metrics: Object.fromEntries(metricNames.map(name => {
      const baseline = metric(pair.baseline, name), typelatch = metric(pair.typelatch, name)
      const delta = baseline === null || typelatch === null ? null : typelatch - baseline
      return [name, { baseline, typelatch, delta, percentChange: delta === null || baseline === 0 ? null : delta / baseline * 100 }]
    })),
  }))
  return {
    runCount: runs.length, arms, pairs,
    limitations: [
      'All attempted runs remain in the report. Metrics are not filtered by correctness.',
      'Input tokens include cached input. Reasoning output is included in output tokens. Total tokens equal input plus output, without adding component fields again.',
      'Usage is terminal Codex CLI accounting, not a provider invoice or independently verified model snapshot. Unknown fields remain null.',
      'Search counts are completed shell call groups containing recognized rg, grep, egrep or fgrep commands. A compound call counts once, even if it launches several searches. File listing and content search can overlap within one call.',
      'Shell parsing does not observe every operating system process. Dynamic evaluation is flagged; searches inside scripts, other languages, aliases or tools can escape this narrow metric. Other shell calls and MCP calls remain visible.',
      'Incomplete capture counts are lower bounds in each raw run and are excluded from complete aggregate metrics. Missing metrics never become zero.',
      'Paired differences are Typelatch minus baseline. Negative time and token differences mean lower observed use. Percent changes with a zero baseline are undefined.',
      'Repeated runs on the same authored tasks are not independent task diversity or a general performance estimate.',
    ],
  }
}
