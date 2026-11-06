import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeValidationObservation, substitute } from './capture.mjs'

const command = (id, passed) => JSON.stringify({ type: 'item.completed', item: { id, type: 'command_execution', command: '/bin/zsh -c "npm run test:typelatch-benchmark"', exit_code: passed ? 0 : 1, aggregated_output: '\n> test:typelatch-benchmark\n' + JSON.stringify({ passed, cases: 3, results: [1, 2, 3] }) + '\n' } })
test('observed native checks retain failure and later check without exporting tool output', () => {
  const result = nativeValidationObservation([command('1', false), command('2', true)].join('\n'), 3)
  assert.equal(result.failingThenLaterCheckObserved, true)
  assert.equal(result.checks.length, 2)
  assert(!JSON.stringify(result).includes('aggregated_output'))
})
test('reasoning, duplicates, other commands and wrong case counts cannot supply check evidence', () => {
  const raw = [command('1', false), command('1', false), JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'private', aggregated_output: command('2', true) } }), command('2', true).replace('npm run test:typelatch-benchmark', 'echo hello')].join('\n')
  assert.equal(nativeValidationObservation(raw, 3).checks.length, 1)
  assert.equal(nativeValidationObservation(raw, 12).checks.length, 0)
})
test('only declared run placeholders are substituted', () => {
  assert.deepEqual(substitute({ args: ['{workspace}', '{state}/cache', '$HOME', '{unknown}'] }, { workspace: '/a', state: '/b' }), { args: ['/a', '/b/cache', '$HOME', '{unknown}'] })
})
test('two checks in one shell command preserve per-check state and aggregate exit', () => {
  const row = JSON.parse(command('combined', false)), second = JSON.parse(command('other', true))
  row.item.exit_code = 0
  row.item.aggregated_output += second.item.aggregated_output
  const result = nativeValidationObservation(JSON.stringify(row), 3)
  assert.equal(result.failingThenLaterCheckObserved, true)
  assert.deepEqual(result.checks.map(check => check.passed), [false, true])
  assert.deepEqual(result.checks.map(check => check.commandExitCode), [0, 0])
  assert(result.checks.every(check => check.individualCheckExitCode === null))
})

test('MCP environment overrides are TOML leaf assignments with exact string values', async () => {
  const { invocation } = await import('./capture.mjs')
  const call = invocation({ workspace: '/fixture', state: '/run-state', prompt: 'Reply OK without using tools.', servers: {
    example: { command: '/bin/echo', args: ['--stdio'], cwd: '{workspace}', env: { EXAMPLE_HOME: '{state}/cache', EXAMPLE_USAGE: 'off', EXAMPLE_SPECIAL: 'quote" and newline\n' }, startup_timeout_sec: 60, tool_timeout_sec: 180, tools: ['lookup'] },
  } })
  const overrides = call.args.flatMap((value, index) => value === '-c' ? [call.args[index + 1]] : [])
  assert(!overrides.some(value => value.startsWith('mcp_servers.example.env=')), 'A JSON object is not a TOML inline table')
  assert(overrides.includes('mcp_servers.example.env.EXAMPLE_HOME="/run-state/cache"'))
  assert(overrides.includes('mcp_servers.example.env.EXAMPLE_USAGE="off"'))
  assert(overrides.includes('mcp_servers.example.env.EXAMPLE_SPECIAL=' + JSON.stringify('quote" and newline\n')))
  assert(overrides.includes('mcp_servers.example.args=["--stdio"]'))
  assert(overrides.includes('mcp_servers.example.required=true'))
})

test('MCP environment rejects nonstring values and ambiguous TOML key names', async () => {
  const { invocation } = await import('./capture.mjs')
  for (const env of [{ INVALID: false }, { INVALID: 7 }, { 'INVALID.KEY': 'text' }]) {
    assert.throws(() => invocation({ workspace: '/fixture', state: '/state', prompt: 'OK', servers: {
      example: { command: '/bin/echo', args: [], cwd: '{workspace}', env, tools: ['lookup'] },
    } }), /named string leaves/u)
  }
})
