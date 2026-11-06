import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pairedConfig, cleanEnvironment, resolvedCodexBinary, createTimedEventRecorder, stopOwnedProcessGroup, hash } from '../../../../scripts/paired-agent-runner.mjs'

export function substitute(value, variables) {
  if (typeof value === 'string') return value.replace(/\{(workspace|state)\}/gu, (_, key) => variables[key])
  if (Array.isArray(value)) return value.map(item => substitute(item, variables))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, variables)]))
  return value
}

export function invocation({ workspace, state, prompt, servers }) {
  const config = { ...pairedConfig }
  for (const [name, frozen] of Object.entries(servers)) {
    assert(/^[a-z][a-z0-9_]*$/u.test(name), 'Safe MCP server name required')
    const server = substitute(frozen, { workspace, state })
    for (const key of ['command', 'args', 'cwd', 'startup_timeout_sec', 'tool_timeout_sec']) if (server[key] !== undefined) config[`mcp_servers.${name}.${key}`] = server[key]
    // Codex CLI overrides parse TOML values, so JSON object syntax cannot encode env.
    for (const [key, value] of Object.entries(server.env ?? {})) {
      assert(/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof value === 'string', 'MCP environment requires named string leaves')
      config[`mcp_servers.${name}.env.${key}`] = value
    }
    config[`mcp_servers.${name}.required`] = true
    for (const tool of server.tools) config[`mcp_servers.${name}.tools.${tool}.approval_mode`] = 'approve'
  }
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--strict-config', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', workspace]
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`)
  args.push(prompt)
  return { command: resolvedCodexBinary().path, args, config, env: cleanEnvironment() }
}

export function nativeValidationObservation(raw, expectedCases) {
  const checks = [], seen = new Set()
  for (const [line, text] of raw.split('\n').entries()) {
    let row
    try { row = JSON.parse(text) } catch { continue }
    const item = row.item
    if (row.type !== 'item.completed' || item?.type !== 'command_execution' || typeof item.id !== 'string' || seen.has(item.id)) continue
    seen.add(item.id)
    if (typeof item.command !== 'string' || !/\bnpm\s+run\s+test:typelatch-benchmark\b/u.test(item.command) || typeof item.aggregated_output !== 'string') continue
    const results = item.aggregated_output.split('\n').flatMap(text => { try { return [JSON.parse(text)] } catch { return [] } }).filter(value => value?.cases === expectedCases && Array.isArray(value.results) && value.results.length === expectedCases && typeof value.passed === 'boolean')
    for (const [resultIndex, result] of results.entries()) checks.push({ line: line + 1, actionIdSha256: hash(item.id), commandExitCode: item.exit_code, individualCheckExitCode: null, resultIndex, passed: result.passed, cases: expectedCases, outputSha256: hash(item.aggregated_output) })
  }
  return { checks, failingThenLaterCheckObserved: checks.length >= 2 && checks[0].passed === false, limitation: 'Checks are identified from completed native command and public runner output, including multiple check outputs in one command. Command exit is aggregate; individual check exit codes are unknown. This confirms an observed failing check followed by a later check; it does not reconstruct every source write hidden inside shell commands.' }
}

export async function captureAgent({ workspace, state, prompt, servers, output, timeoutMs }) {
  mkdirSync(output, { recursive: true })
  const call = invocation({ workspace, state, prompt, servers })
  const stdoutPath = join(output, 'raw-events.jsonl'), stderrPath = join(output, 'stderr.txt')
  const out = openSync(stdoutPath, 'wx', 0o600), err = openSync(stderrPath, 'wx', 0o600)
  const startedAt = new Date().toISOString(), start = performance.now(), recorder = createTimedEventRecorder(out, start)
  const child = spawn(call.command, call.args, { cwd: workspace, env: call.env, detached: true, stdio: ['ignore', 'pipe', err] })
  let timedOut = false, recordingError = null, forceTimer
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }; forceTimer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }, 5000) }
  child.stdout.on('data', chunk => { if (recordingError) return; try { recorder.write(chunk) } catch (error) { recordingError = error.code ?? 'recording-failed'; stop() } })
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  const exit = await new Promise(done => { child.once('error', error => done({ exitCode: null, signal: null, spawnError: error.code ?? 'unknown' })); child.once('close', (exitCode, signal) => done({ exitCode, signal, spawnError: null })) })
  const elapsedMs = performance.now() - start, finishedAt = new Date().toISOString()
  clearTimeout(timer); clearTimeout(forceTimer)
  const timing = recorder.finish(); closeSync(out); closeSync(err)
  const processGroupStopped = child.pid ? await stopOwnedProcessGroup(child.pid) : null
  const result = { ...exit, timedOut, recordingError, startedAt, finishedAt, elapsedMs, processGroupStopped, timing, rawSha256: hash(readFileSync(stdoutPath)), stderrSha256: hash(readFileSync(stderrPath)), config: call.config }
  writeFileSync(join(output, 'process-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(join(output, 'event-timing.json'), JSON.stringify({ meaning: 'Monotonic receipt offsets of complete JSONL lines, not individual tool durations.', timing }, null, 2) + '\n', { mode: 0o600 })
  return { ...result, raw: readFileSync(stdoutPath, 'utf8') }
}
