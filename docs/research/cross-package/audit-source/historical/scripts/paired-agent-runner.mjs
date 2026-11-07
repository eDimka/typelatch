import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

export const pairedConfig = Object.freeze({
  model: 'gpt-6.1-sol',
  model_reasoning_effort: 'medium',
  approval_policy: 'never',
  project_doc_max_bytes: 0,
  allow_login_shell: false,
  'skills.include_instructions': false,
  'skills.bundled.enabled': false,
  'features.skip_host_skill_discovery': true,
  'features.skill_search': false,
  'features.apps': false,
  'features.plugins': false,
  'features.multi_agent': false,
  'features.memories': false,
  'features.hooks': false,
  web_search: 'disabled',
  'history.persistence': 'none',
  'shell_environment_policy.inherit': 'core',
})

export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
export const cleanEnvironment = () => Object.fromEntries(['HOME', 'CODEX_HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))

let codexPath
function pinnedCodexPath() {
  if (!codexPath) {
    const found = spawnSync('/usr/bin/which', ['codex'], { env: cleanEnvironment(), encoding: 'utf8', timeout: 10_000 })
    assert.equal(found.status, 0, 'Codex must be installed before freezing the benchmark')
    const candidates = found.stdout.trim().split('\n')
    assert.equal(candidates.length, 1, 'Codex lookup must resolve one executable')
    assert(candidates[0].startsWith('/'), 'Codex executable path must be absolute')
    codexPath = realpathSync(candidates[0])
  }
  return codexPath
}

export function resolvedCodexBinary() {
  const path = pinnedCodexPath(), bytes = readFileSync(path)
  return { path, bytes: bytes.length, sha256: hash(bytes) }
}

export function invocation({ workspace, prompt, packageRoot = null }) {
  const config = { ...pairedConfig }
  if (packageRoot) {
    Object.assign(config, {
      'mcp_servers.typelatch.command': process.execPath,
      'mcp_servers.typelatch.args': [join(packageRoot, 'dist/mcp.js')],
      'mcp_servers.typelatch.cwd': workspace,
      'mcp_servers.typelatch.required': true,
      'mcp_servers.typelatch.env.TYPELATCH_HOME': join(workspace, '.typelatch'),
      'mcp_servers.typelatch.env.TYPELATCH_USAGE': 'off',
      'mcp_servers.typelatch.startup_timeout_sec': 60,
      'mcp_servers.typelatch.tool_timeout_sec': 180,
    })
    for (const name of ['workspace_search', 'workspace_context', 'workspace_validate', 'library_search', 'library_symbol', 'library_feedback', 'library_stats']) config[`mcp_servers.typelatch.tools.${name}.approval_mode`] = 'approve'
  }
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--strict-config', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', workspace]
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${JSON.stringify(value)}`)
  args.push(prompt)
  return { command: pinnedCodexPath(), args, config, env: cleanEnvironment() }
}

function alive(pid) {
  try { process.kill(-pid, 0); return true } catch (error) { return error.code === 'ESRCH' ? false : null }
}

export async function stopOwnedProcessGroup(pid, { graceMs = 2000, killMs = 3000, intervalMs = 100 } = {}) {
  assert(Number.isInteger(pid) && pid > 0, 'Only a known owned process group may be stopped')
  const waitForExit = async duration => {
    const deadline = performance.now() + duration
    while (alive(pid) !== false && performance.now() < deadline) await new Promise(done => setTimeout(done, intervalMs))
    return alive(pid) === false
  }
  if (alive(pid) === false) return true
  try { process.kill(-pid, 'SIGTERM') } catch {}
  if (await waitForExit(graceMs)) return true
  try { process.kill(-pid, 'SIGKILL') } catch {}
  return waitForExit(killMs)
}

export function createTimedEventRecorder(fd, started, clock = () => performance.now()) {
  let pending = Buffer.alloc(0), line = 0, finished = false
  const timing = []
  const types = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error', 'item.started', 'item.updated', 'item.completed'])
  const itemTypes = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'reasoning', 'agent_message', 'todo_list', 'error'])
  function record(bytes, elapsedMs) {
    line++
    if (!bytes.toString('utf8').trim()) { timing.push({ line, elapsedMs, type: 'blank' }); return }
    let row
    try { row = JSON.parse(bytes.toString('utf8')) } catch { timing.push({ line, elapsedMs, type: 'invalid_json' }); return }
    const event = { line, elapsedMs, type: types.has(row?.type) ? row.type : 'unknown' }
    if (typeof row?.item?.id === 'string') event.itemIdHash = hash(row.item.id)
    if (row?.item) event.itemType = itemTypes.has(row.item.type) ? row.item.type : 'unknown'
    timing.push(event)
  }
  return {
    timing,
    write(chunk) {
      assert(!finished && Buffer.isBuffer(chunk), 'Recorder needs raw bytes before finalization')
      const elapsedMs = clock() - started
      assert(Number.isFinite(elapsedMs) && elapsedMs >= 0, 'Recorder clock must be monotonic')
      for (let offset = 0; offset < chunk.length;) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset)
        assert(written > 0, 'Recorder did not persist input bytes')
        offset += written
      }
      pending = Buffer.concat([pending, chunk])
      let newline
      while ((newline = pending.indexOf(10)) !== -1) {
        record(pending.subarray(0, newline), elapsedMs)
        pending = pending.subarray(newline + 1)
      }
    },
    finish() {
      assert(!finished, 'Recorder may only be finalized once')
      finished = true
      if (pending.length) record(pending, clock() - started)
      pending = Buffer.alloc(0)
      return timing
    },
  }
}

export async function runAgent({ workspace, prompt, output, packageRoot = null, timeoutMs = 600_000 }) {
  mkdirSync(output, { recursive: true })
  const call = invocation({ workspace, prompt, packageRoot })
  const stdoutPath = join(output, 'raw-events.jsonl'), stderrPath = join(output, 'stderr.txt')
  const out = openSync(stdoutPath, 'wx', 0o600), err = openSync(stderrPath, 'wx', 0o600)
  const startedAt = new Date().toISOString(), start = performance.now()
  const recorder = createTimedEventRecorder(out, start)
  const child = spawn(call.command, call.args, { cwd: workspace, env: call.env, detached: true, stdio: ['ignore', 'pipe', err] })
  let timedOut = false, forceTimer, recordingError = null
  const stop = () => {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
  }
  child.stdout.on('data', chunk => {
    if (recordingError) return
    try { recorder.write(chunk) }
    catch (error) { recordingError = error.code ?? 'recording-failed'; stop() }
  })
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  const exit = await new Promise(done => {
    child.once('error', error => done({ exitCode: null, signal: null, spawnError: error.code ?? 'unknown' }))
    child.once('close', (exitCode, signal) => done({ exitCode, signal, spawnError: null }))
  })
  const elapsedMs = performance.now() - start, finishedAt = new Date().toISOString()
  clearTimeout(timer); clearTimeout(forceTimer)
  const timing = recorder.finish()
  closeSync(out); closeSync(err)
  // Only the process group created for this session may be cleaned up.
  const processGroupStopped = child.pid ? await stopOwnedProcessGroup(child.pid) : null
  writeFileSync(join(output, 'event-timing.json'), JSON.stringify({ meaning: 'Monotonic recorder receipt time for each complete JSONL line. This is not the execution duration of a tool.', timing }, null, 2) + '\n', { mode: 0o600 })
  const result = { ...exit, timedOut, recordingError, startedAt, finishedAt, elapsedMs, processGroupStopped, timing, rawSha256: hash(readFileSync(stdoutPath)), stderrSha256: hash(readFileSync(stderrPath)), config: call.config }
  writeJson(join(output, 'process-result.json'), result)
  return { ...result, raw: readFileSync(stdoutPath, 'utf8') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], '--preflight', 'This runner entrypoint is only an excluded infrastructure preflight')
  const directory = resolve(process.argv[3]); mkdirSync(directory, { recursive: true })
  const workspace = join(directory, 'workspace'); mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.txt'), 'Infrastructure preflight. No benchmark task is present.\n')
  const result = await runAgent({ workspace, prompt: 'Reply with the single word OK. Do not call tools or inspect any files.', output: join(directory, 'capture'), timeoutMs: 120_000 })
  const rows = result.raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const terminal = rows.filter(row => row.type === 'turn.completed').map(row => row.usage)
  console.log(JSON.stringify({ exitCode: result.exitCode, elapsedMs: result.elapsedMs, terminalUsage: terminal, cliVersion: spawnSync(pinnedCodexPath(), ['--version'], { encoding: 'utf8' }).stdout.trim(), rawSha256: result.rawSha256 }))
  assert.equal(result.exitCode, 0, 'Preflight failed; inspect ignored stderr without publishing private events')
  assert.equal(terminal.length, 1, 'Preflight must expose one terminal usage record')
}
