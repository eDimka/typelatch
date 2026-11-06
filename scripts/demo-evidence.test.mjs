import assert from 'node:assert/strict'
import { test } from 'node:test'
import { demoResult, verifyDemoActions } from './demo-evidence.mjs'

const workspace = '/exercise'
const context = { workspace, beforeSha256: 'before-source', afterSha256: 'after-source' }
const mcp = (tool, result, args = {}) => ({ type: 'mcp_tool_call', server: 'typelatch', tool, arguments: args, status: 'completed', result: { structuredContent: result } })
function validation(status, sourceHash) {
  const passed = status === 'pass'
  return mcp('workspace_validate', {
    checks: { typechecked: { status: 'pass' }, tested: { status }, stable: { status: 'pass' } },
    snapshot: { config: '/exercise/tsconfig.json', inputs: [{ file: '/exercise/batch.ts', sha256: sourceHash }] },
    execution: { command: ['npm', 'test'], cwd: workspace, status, exitCode: passed ? 0 : 1, signal: null, timedOut: false, cancelled: false, outputLimitExceeded: false,
      stdout: `ok 1 - commits the whole valid batch and binds a quote as data\n${passed ? 'ok' : 'not ok'} 2 - UNIQUE failure rolls back an earlier insert in the same batch\n# tests 2\n# pass ${passed ? 2 : 1}\n# fail ${passed ? 0 : 1}\n`, stderr: '' },
  }, { config: '/exercise/tsconfig.json', workspaceRoot: workspace, testCommand: ['npm', 'test'] })
}
function goodActions() {
  return [
    mcp('workspace_search', { results: [{ origin: 'workspace', source: '/exercise/batch.ts', snippet: 'export async function importContacts() {}' }], sourceContext: { files: [{ source: '/exercise/batch.ts', text: 'export async function importContacts() {}' }] } }, { workspaceRoot: workspace, question: 'Fix contact import rollback', detail: 'source' }),
    validation('fail', 'before-source'),
    mcp('library_symbol', { package: 'kysely', version: '0.28.8', lookup: { status: 'exact' }, results: [{ symbol: 'esm/kysely.TransactionBuilder', signature: 'execute<T>(callback: (trx: Transaction<DB>) => Promise<T>): Promise<T>;', source: 'dist/esm/kysely.d.ts', line: 623 }] }, { package: 'kysely', version: '0.28.8', symbol: 'esm/kysely.TransactionBuilder' }),
    { type: 'file_change', changes: [{ path: '/exercise/batch.ts', kind: 'update' }], status: 'completed' },
    validation('pass', 'after-source'),
  ]
}

test('accepts ordered discovery, exact API and executed before and after assertions', () => {
  assert.doesNotThrow(() => verifyDemoActions(goodActions(), context))
})

test('denied, failed and MCP error envelopes never qualify', () => {
  for (const mutation of [a => { a.status = 'failed' }, a => { a.error = { message: 'Requires approval' } }, a => { a.result.isError = true }, a => { a.result.is_error = true }]) {
    const actions = goodActions(); mutation(actions[0])
    assert.equal(demoResult(actions[0]), null)
    assert.throws(() => verifyDemoActions(actions, context), /workspace_search/)
  }
})

test('empty source discovery cannot qualify', () => {
  const actions = goodActions(); actions[0].result.structuredContent = { results: [], sourceContext: { files: [] } }
  assert.throws(() => verifyDemoActions(actions, context), /source|workspace_search/)
})

test('missing API lookup cannot qualify as dependency evidence', () => {
  const actions = goodActions(); actions[2].result.structuredContent = { package: 'kysely', version: '0.28.8', lookup: { status: 'not-found' }, results: [] }
  assert.throws(() => verifyDemoActions(actions, context), /API/)
})

test('unresolved context cannot qualify as dependency evidence', () => {
  const actions = goodActions(); actions[2] = mcp('workspace_context', { checks: { resolved: { status: 'unknown' } }, dependency: null, api: null })
  assert.throws(() => verifyDemoActions(actions, context), /API/)
})

test('a validation without execution details cannot qualify', () => {
  const actions = goodActions(); delete actions[1].result.structuredContent.execution
  assert.throws(() => verifyDemoActions(actions, context), /baseline|execution/)
})

test('a different command or workspace cannot establish the baseline', () => {
  for (const mutation of [r => { r.execution.command = ['true'] }, r => { r.execution.cwd = '/elsewhere' }]) {
    const actions = goodActions(); mutation(actions[1].result.structuredContent)
    assert.throws(() => verifyDemoActions(actions, context), /baseline|execution/)
  }
})

test('a different failure cannot stand in for the rollback assertion', () => {
  const actions = goodActions(); actions[1].result.structuredContent.execution.stdout = 'npm script missing'
  assert.throws(() => verifyDemoActions(actions, context), /baseline|rollback/)
})

test('the original baseline must precede the first edit', () => {
  const actions = goodActions(); actions.unshift(actions.splice(3, 1)[0])
  assert.throws(() => verifyDemoActions(actions, context), /before|baseline|discovery/)
})

test('the final validation must follow the last edit', () => {
  const actions = goodActions(); actions.push(actions.splice(3, 1)[0])
  assert.throws(() => verifyDemoActions(actions, context), /after|Final/)
})

test('a later denied validation cannot be replaced with an earlier successful check', () => {
  const actions = goodActions(); actions.push({ type: 'mcp_tool_call', server: 'typelatch', tool: 'workspace_validate', status: 'failed', error: { message: 'Requires approval' } })
  assert.throws(() => verifyDemoActions(actions, context), /Final/)
})

test('validation source hashes bind baseline and final evidence to the actual edit', () => {
  for (const index of [1, 4]) {
    const actions = goodActions(); actions[index].result.structuredContent.snapshot.inputs[0].sha256 = 'unrelated-source'
    assert.throws(() => verifyDemoActions(actions, context), /baseline|Final|source/)
  }
})

test('another server cannot impersonate Typelatch evidence', () => {
  const actions = goodActions(); actions[0].server = 'unrelated'
  assert.throws(() => verifyDemoActions(actions, context), /workspace_search/)
})

test('normal shell reading and API preparation may accompany a qualified run', () => {
  const actions = goodActions(); actions.splice(2, 0, { type: 'command_execution', command: 'cat batch.ts && typelatch add kysely@0.28.8', exitCode: 0, output: 'source and preparation' })
  assert.doesNotThrow(() => verifyDemoActions(actions, context))
})

test('fixture snapshots detect changed configuration and any new file', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { snapshotDemoFiles, verifyDemoFiles } = await import('./demo-evidence.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'typelatch-demo-evidence-'))
  try {
    writeFileSync(join(directory, 'batch.ts'), 'before')
    writeFileSync(join(directory, 'package.json'), '{"scripts":{"test":"real assertions"}}')
    mkdirSync(join(directory, 'node_modules')); writeFileSync(join(directory, 'node_modules/cache'), 'ignored')
    const before = snapshotDemoFiles(directory)
    writeFileSync(join(directory, 'batch.ts'), 'after')
    assert.doesNotThrow(() => verifyDemoFiles(before, snapshotDemoFiles(directory)))
    writeFileSync(join(directory, 'package.json'), '{"scripts":{"test":"true"}}')
    assert.throws(() => verifyDemoFiles(before, snapshotDemoFiles(directory)), /Protected fixture entry changed/)
    writeFileSync(join(directory, 'package.json'), '{"scripts":{"test":"real assertions"}}')
    writeFileSync(join(directory, 'new-config.json'), '{}')
    assert.throws(() => verifyDemoFiles(before, snapshotDemoFiles(directory)), /added or removed/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('public action export excludes native IDs, private analysis and unknown item fields', async () => {
  const { publicDemoActions } = await import('./demo-evidence.mjs')
  const rows = [
    { type: 'thread.started', thread_id: 'private-thread' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'private analysis' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'unreviewed final message' } },
    { type: 'item.completed', item: { type: 'command_execution', id: 'private-item', command: 'npm test', aggregated_output: 'public output', exit_code: 0, analysis: 'private analysis' } },
  ]
  assert.deepEqual(publicDemoActions(rows), [{ type: 'command_execution', command: 'npm test', output: 'public output', exitCode: 0 }])
})

test('normalization strips known private roots and both macOS temp path forms', async () => {
  const { normalizeDemo } = await import('./demo-evidence.mjs')
  const result = normalizeDemo({ path: '/Users/person/project/exercise/batch.ts', code: 'read /private/var/folders/zz/temp/test.ts and /var/folders/aa/other/result and /tmp/private/output' }, [['/Users/person/project', '$REPOSITORY'], ['/Users/person/project/exercise', '$WORKSPACE'], ['/Users/person', '$USER_HOME']])
  assert.equal(result.path, '$WORKSPACE/batch.ts')
  assert.equal(result.code, 'read $TEMP and $TEMP and $TEMP')
})


test('relative config uses the MCP workspace while the snapshot confirms its actual owner', () => {
  const actions = goodActions()
  actions[1].arguments.config = 'tsconfig.json'
  actions[4].arguments.config = './tsconfig.json'
  assert.doesNotThrow(() => verifyDemoActions(actions, context))
  actions[4].result.structuredContent.snapshot.config = '/elsewhere/tsconfig.json'
  assert.throws(() => verifyDemoActions(actions, context), /Final/)
})


test('successful plain text MCP replies count as transport successes without becoming API evidence', async () => {
  const { successfulDemoMcp } = await import('./demo-evidence.mjs')
  const action = { type: 'mcp_tool_call', server: 'typelatch', tool: 'library_feedback', status: 'completed', result: { content: [{ type: 'text', text: 'Outcome recorded' }] } }
  assert.equal(successfulDemoMcp(action), true)
  assert.equal(demoResult(action), null)
})
