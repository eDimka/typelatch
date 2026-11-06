import assert from 'node:assert/strict'
import { demoHash, demoResult, successfulDemoMcp, verifyAssertionOutput, verifyDemoActions, verifyDemoFiles } from './demo-evidence.mjs'

const whitespace = value => value.replace(/\s+/g, '')
const fixtureHash = (files, path) => files.find(file => file.path === path && file.kind === 'file')?.sha256

export function verifySiteDemo(recordText, demo) {
  const record = JSON.parse(recordText)
  assert.equal(demo.version, 2, 'The walkthrough must use the native session schema')
  assert.equal(demo.source.path, 'docs/showcase/codex-session.json')
  assert.equal(demo.source.sha256, demoHash(recordText), 'Walkthrough record hash matches the exact public capture')
  for (const key of ['startedAt', 'finishedAt', 'packageVersion', 'packageSource'])
    assert.equal(demo.source[key], record.provenance[key], `Walkthrough provenance matches: ${key}`)
  assert.equal(record.provenance.kind, 'Actual Codex CLI session on an authored isolated exercise')
  assert.equal(record.provenance.distManifestSha256, demoHash(JSON.stringify(record.provenance.distManifest)), 'Recorded build manifest hash matches')
  assert.equal(record.change.file, 'batch.ts')
  assert.equal(record.change.beforeSha256, demoHash(record.change.before), 'Original source hash matches its recorded text')
  assert.equal(record.change.afterSha256, demoHash(record.change.after), 'Final source hash matches its recorded text')
  verifyDemoFiles(record.fixture.before, record.fixture.after)
  assert.equal(fixtureHash(record.fixture.before, 'batch.ts'), record.change.beforeSha256)
  assert.equal(fixtureHash(record.fixture.after, 'batch.ts'), record.change.afterSha256)
  assert.equal(record.verification.testsUnchanged, true)
  assert.equal(record.verification.testSha256, fixtureHash(record.fixture.before, 'batch.test.ts'))
  verifyAssertionOutput(record.baselineVerification.stdout, false)
  verifyAssertionOutput(record.verification.stdout, true)
  assert.equal(record.baselineVerification.exitCode, 1)
  assert.equal(record.verification.exitCode, 0)

  // Public paths are normalized. Rebase them only for verifier path equality.
  const workspace = '/recorded/workspace'
  const actions = JSON.parse(JSON.stringify(record.actions).replaceAll('$WORKSPACE', workspace))
  const qualified = verifyDemoActions(actions, { workspace, beforeSha256: record.change.beforeSha256, afterSha256: record.change.afterSha256 })
  assert.deepEqual(record.qualified, qualified, 'Recorded qualified action indices are recomputed')
  const mcp = record.actions.filter(action => action.type === 'mcp_tool_call' && action.server === 'typelatch')
  const counts = {
    mcpCalls: mcp.length,
    successfulMcpCalls: mcp.filter(successfulDemoMcp).length,
    failedMcpCalls: mcp.filter(action => !successfulDemoMcp(action)).length,
    shellCommands: record.actions.filter(action => action.type === 'command_execution').length,
    grepCommands: record.actions.filter(action => action.type === 'command_execution' && /\b(?:rg|grep)\b/.test(action.command)).length,
  }
  for (const [name, value] of Object.entries(counts)) assert.equal(record.counts[name], value, `Recorded action count matches: ${name}`)
  const search = demoResult(record.actions[qualified.searchAction])
  for (const file of search.sourceContext.files) {
    assert.ok(file.source.startsWith('$WORKSPACE/'), 'Source context stays in the recorded exercise')
    assert.equal(file.sha256, fixtureHash(record.fixture.before, file.source.slice('$WORKSPACE/'.length)), 'Source context identity matches the original fixture')
    if (file.complete) {
      assert.equal(demoHash(file.text), file.sha256, 'Complete source context hash matches its text')
      assert.equal(Buffer.byteLength(file.text), file.bytes, 'Complete source context byte count matches')
    }
  }

  const expected = new Map([
    ['connect', []], ['discover', [qualified.searchAction]], ['reproduce', [qualified.baselineAction]],
    ['inspect', [qualified.apiAction]], ['edit', qualified.editActions], ['verify', [qualified.finalValidationAction]],
  ])
  assert.deepEqual(demo.scenes.map(scene => scene.id), [...expected.keys()], 'Walkthrough preserves the qualified action order')
  for (const scene of demo.scenes) {
    assert.ok(Number.isFinite(scene.durationMs) && scene.durationMs >= 3000)
    assert.deepEqual(scene.evidence.actionIndex === undefined ? [] : [scene.evidence.actionIndex], expected.get(scene.id), `Scene references its qualified action: ${scene.id}`)
    assert.equal(scene.kind, scene.id === 'connect' ? 'instructions' : 'recorded-session')
    const action = record.actions[expected.get(scene.id)[0]]
    if (action?.type === 'mcp_tool_call') {
      assert.deepEqual(scene.evidence.request, { name: action.tool, arguments: action.arguments }, `Scene request matches its action: ${scene.id}`)
      assert.ok(scene.code.includes(action.tool), `Displayed code names its actual tool: ${scene.id}`)
    } else assert.equal(scene.evidence.request, undefined, 'Instructions and edits must not fabricate MCP requests')
    if (scene.id === 'connect') {
      assert.ok(scene.code.includes(`npx typelatch@${record.provenance.packageVersion} setup`), 'Setup instruction pins the recorded version')
      assert.ok(scene.code.includes(`npx typelatch@${record.provenance.packageVersion} sync`), 'Preparation instruction pins the recorded version')
    }
    if (scene.id === 'discover') {
      assert.ok(scene.code.includes(action.arguments.question), 'Displayed search question matches the actual request')
      assert.deepEqual(scene.evidence.sourceFiles, search.sourceContext.files.map(({ source, sha256, complete }) => ({ source, sha256, complete })), 'Displayed source identities match the capture')
      assert.equal(scene.evidence.coverageComplete, search.coverage.complete)
      assert.equal(scene.evidence.missingIndexes, search.coverage.missingIndexes)
      assert.ok(scene.code.includes(`Coverage: ${search.coverage.complete ? 'complete' : 'partial'}`), 'Displayed coverage state matches the capture')
      assert.ok(scene.code.includes(`${search.coverage.missingIndexes} missing dependency indexes`), 'Displayed coverage gaps match the capture')
    }
    if (scene.id === 'inspect') {
      const result = demoResult(action)
      const api = result.api
      assert.ok(scene.code.includes(action.arguments.symbol), 'Displayed API uses the actual symbol')
      assert.ok(api.signatures.includes(scene.evidence.signature), 'API evidence signature matches its response')
      assert.ok(scene.code.includes(scene.evidence.signature), 'Displayed signature comes from the actual API response')
      assert.equal(scene.evidence.package, result.dependency.name)
      assert.equal(scene.evidence.version, result.dependency.version)
      assert.equal(scene.evidence.symbol, action.arguments.symbol)
      assert.equal(scene.evidence.versionMatch, result.checks.versionMatch.status)
      assert.equal(scene.evidence.artifactMatch, result.checks.artifactMatch.status)
      assert.equal(scene.evidence.declaredHeaderStatus, api.evidence.declarations.headers[0].status)
      assert.ok(scene.code.includes(`Normalized declaration header: ${scene.evidence.declaredHeaderStatus}`), 'Displayed declaration status remains explicit')
    }
    if (scene.id === 'edit') {
      assert.ok(whitespace(record.change.after).includes(whitespace(scene.code)), 'Displayed edit is an excerpt of the actual final source')
      assert.ok(record.change.after.includes(scene.evidence.actualSource), 'Authored source excerpt matches the actual edit')
      assert.equal(scene.evidence.beforeSha256, record.change.beforeSha256)
      assert.equal(scene.evidence.afterSha256, record.change.afterSha256)
      assert.equal(scene.evidence.testsUnchanged, record.verification.testsUnchanged)
    }
    if (scene.id === 'reproduce' || scene.id === 'verify') {
      const result = demoResult(action)
      assert.equal(scene.evidence.compilation, result.checks.typechecked.status)
      assert.equal(scene.evidence.tests, result.checks.tested.status)
      if (scene.id === 'verify') {
        assert.equal(scene.evidence.stability, result.checks.stable.status)
        assert.equal(scene.evidence.independentExitCode, record.verification.exitCode)
        assert.ok(scene.caption.includes(`${counts.mcpCalls} MCP calls`), 'Displayed MCP count matches the capture')
        if (scene.caption.includes('no rg or grep commands')) assert.equal(counts.grepCommands, 0)
      }
      const passed = scene.id === 'verify'
      const assertion = `${passed ? 'ok' : 'not ok'} 2 - UNIQUE failure rolls back an earlier insert in the same batch`
      assert.ok(scene.code.includes(assertion), 'Displayed rollback assertion matches the actual outcome')
      for (const text of ['# tests 2', `# pass ${passed ? 2 : 1}`, `# fail ${passed ? 0 : 1}`])
        assert.ok(scene.code.includes(text), 'Displayed test counts match the recorded outcome')
    }
  }
  return { record, qualified, counts }
}
