import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export const demoHash = value => createHash('sha256').update(value).digest('hex')
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a) === resolve(b)
const isMcp = action => action?.type === 'mcp_tool_call' && action.server === 'typelatch'
const isArgv = command => Array.isArray(command) && command.length === 2 && command[0] === 'npm' && command[1] === 'test'
const hasText = value => typeof value === 'string' && value.trim().length > 0

export function successfulDemoMcp(action) {
  const result = action?.result
  return Boolean(isMcp(action) && result && !action.error && action.status === 'completed' && !result.isError && !result.is_error)
}

export function demoResult(action) {
  const result = action?.result
  if (!successfulDemoMcp(action)) return null
  const value = result.structuredContent ?? result.structured_content ?? result.content?.filter(item => item.type === 'text').map(item => {
    try { return JSON.parse(item.text) } catch { return null }
  }).find(Boolean)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

export function verifyAssertionOutput(stdout, passed) {
  assert.equal(typeof stdout, 'string', 'Assertion stdout is required')
  assert.match(stdout, /^ok 1 - commits the whole valid batch and binds a quote as data$/m, 'Parameter binding assertion must execute')
  assert.match(stdout, passed ? /^ok 2 - UNIQUE failure rolls back an earlier insert in the same batch$/m : /^not ok 2 - UNIQUE failure rolls back an earlier insert in the same batch$/m, 'The exact rollback assertion must execute')
  assert.match(stdout, /^# tests 2$/m, 'Exactly two fixture tests must execute')
  assert.match(stdout, passed ? /^# pass 2$/m : /^# pass 1$/m)
  assert.match(stdout, passed ? /^# fail 0$/m : /^# fail 1$/m)
}

function executedValidation(action, status, { workspace, sourceHash }) {
  const result = demoResult(action)
  const request = action.arguments
  const run = result?.execution
  if (!result || !isArgv(request?.testCommand) || !hasText(request?.config) || !samePath(resolve(workspace, request.config), join(workspace, 'tsconfig.json')) || !samePath(request?.workspaceRoot, workspace) || request.overlays?.length) return false
  if (result.checks?.typechecked?.status !== 'pass' || result.checks?.tested?.status !== status || result.checks?.stable?.status !== 'pass') return false
  if (!run || !isArgv(run.command) || !samePath(run.cwd, workspace) || run.status !== status || run.exitCode !== (status === 'pass' ? 0 : 1)) return false
  if (run.signal !== null || run.timedOut !== false || run.cancelled !== false || run.outputLimitExceeded !== false) return false
  if (!samePath(result.snapshot?.config, join(workspace, 'tsconfig.json')) || !result.snapshot?.inputs?.some(input => samePath(input.file, join(workspace, 'batch.ts')) && input.sha256 === sourceHash)) return false
  try { verifyAssertionOutput(run.stdout, status === 'pass') } catch { return false }
  return true
}

function usableApi(action, expected) {
  const result = demoResult(action)
  const args = action.arguments
  if (!result) return false
  if (action.tool === 'library_symbol') {
    return args?.package === expected.name && args?.version === expected.version && result.package === expected.name && result.version === expected.version && result.lookup?.status === 'exact' && result.results?.some(row => row.symbol === args.symbol && hasText(row.signature) && hasText(row.source) && Number.isInteger(row.line))
  }
  if (action.tool === 'workspace_context') {
    const api = result.api
    return result.checks?.resolved?.status === 'pass' && result.checks?.versionMatch?.status !== 'fail' && result.dependency?.name === expected.name && result.dependency?.version === expected.version && args?.importSpecifier === expected.name && hasText(args.symbol) && api && (hasText(api.type) || api.signatures?.some(hasText)) && api.declarations?.length > 0
  }
  return false
}

export function verifyDemoActions(actions, { workspace, beforeSha256, afterSha256, dependency = { name: 'kysely', version: '0.28.8' } } = {}) {
  assert(workspace && beforeSha256 && afterSha256, 'Frozen workspace and source identities are required')
  const edits = actions.map((action, index) => ({ action, index })).filter(({ action }) => action.type === 'file_change' && action.status === 'completed')
  assert(edits.length > 0, 'A completed implementation edit must be recorded')
  for (const { action } of edits) {
    assert(action.changes?.length > 0, 'An edit must name its changed file')
    assert(action.changes.every(change => samePath(resolve(workspace, change.path), join(workspace, 'batch.ts')) && change.kind === 'update'), 'Recorded edits may only update batch.ts')
  }
  const firstEdit = edits[0].index
  const lastEdit = edits.at(-1).index
  const search = actions.findIndex(action => {
    const result = action.tool === 'workspace_search' ? demoResult(action) : null
    return result && samePath(action.arguments?.workspaceRoot, workspace) && action.arguments?.detail === 'source' && result.results?.some(hit => hit.origin === 'workspace' && samePath(hit.source, join(workspace, 'batch.ts')) && hasText(hit.snippet)) && result.sourceContext?.files?.some(file => samePath(file.source ?? file.path, join(workspace, 'batch.ts')) && hasText(file.text))
  })
  assert(search >= 0, 'Capture needs successful nonempty workspace_search source evidence')
  assert(search < firstEdit, 'Source discovery must happen before the first edit')
  const baseline = actions.findIndex((action, index) => index > search && index < firstEdit && action.tool === 'workspace_validate' && executedValidation(action, 'fail', { workspace, sourceHash: beforeSha256 }))
  assert(baseline >= 0, 'Capture needs an executed failing rollback baseline before the first edit, bound to the original source')
  const api = actions.findIndex((action, index) => index > search && index < firstEdit && usableApi(action, dependency))
  assert(api >= 0, 'Capture needs exact usable dependency API evidence before editing')
  const validationAttempts = actions.map((action, index) => ({ action, index })).filter(({ action }) => isMcp(action) && action.tool === 'workspace_validate')
  const final = validationAttempts.at(-1)
  assert(final && final.index > lastEdit, 'Final validation must happen after the last edit')
  assert(executedValidation(final.action, 'pass', { workspace, sourceHash: afterSha256 }), 'Final validation must execute both assertions successfully against the final source')
  return { searchAction: search, baselineAction: baseline, apiAction: api, finalValidationAction: final.index, editActions: edits.map(item => item.index) }
}

export function snapshotDemoFiles(directory, excluded = ['node_modules', '.git', '.typelatch']) {
  const files = []
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      if (excluded.includes(name)) continue
      const full = join(path, name)
      const stat = lstatSync(full)
      const entry = { path: relative(directory, full).split('\\').join('/') }
      if (stat.isSymbolicLink()) files.push({ ...entry, kind: 'symlink', target: readlinkSync(full) })
      else if (stat.isDirectory()) { files.push({ ...entry, kind: 'directory' }); visit(full) }
      else if (stat.isFile()) files.push({ ...entry, kind: 'file', bytes: stat.size, sha256: demoHash(readFileSync(full)) })
      else throw new Error(`Unsupported fixture entry: ${entry.path}`)
    }
  }
  visit(directory)
  return files
}

export function verifyDemoFiles(before, after) {
  const original = new Map(before.map(file => [file.path, file]))
  const final = new Map(after.map(file => [file.path, file]))
  assert.deepEqual([...final.keys()].sort(), [...original.keys()].sort(), 'Fixture files may not be added or removed')
  for (const [path, file] of original) {
    if (path !== 'batch.ts') assert.deepEqual(final.get(path), file, `Protected fixture entry changed: ${path}`)
    else {
      assert.equal(file.kind, 'file', 'Original implementation must be a regular file')
      assert.equal(final.get(path).kind, 'file', 'Final implementation must be a regular file')
      assert.notEqual(final.get(path).sha256, file.sha256, 'The agent must make a real implementation edit')
    }
  }
}

export function publicDemoActions(rows) {
  return rows.filter(row => row.type === 'item.completed').map(row => row.item).filter(item => ['mcp_tool_call', 'command_execution', 'file_change'].includes(item?.type)).map(item => {
    if (item.type === 'mcp_tool_call') return { type: item.type, server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status: item.status }
    if (item.type === 'command_execution') return { type: item.type, command: item.command, output: item.aggregated_output, exitCode: item.exit_code }
    return { type: item.type, changes: item.changes?.map(change => ({ path: change.path, kind: change.kind })), status: item.status }
  })
}

export function normalizeDemo(value, replacements) {
  if (typeof value === 'string') {
    for (const [from, to] of [...replacements].sort((a, b) => b[0].length - a[0].length)) if (from) value = value.replaceAll(from, to)
    return value.replace(/(?:\/private)?\/var\/folders\/[^\s"'<>]+/g, '$TEMP').replace(/(?:\/private)?\/tmp\/[^\s"'<>]+/g, '$TEMP')
  }
  if (Array.isArray(value)) return value.map(item => normalizeDemo(item, replacements))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeDemo(item, replacements)]))
  return value
}
