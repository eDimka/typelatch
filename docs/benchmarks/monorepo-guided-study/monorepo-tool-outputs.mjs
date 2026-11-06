import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const allowed = new Set(['command_execution', 'mcp_tool_call'])
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const encoded = value => value == null ? null : JSON.stringify(value)
const privatePath = /\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u

// Bind original payloads first. Normalization changes display bytes, never their provenance hashes.
export function extractToolOutputs({ raw, publicRecordBytes, expectedPublicRecordSha256, replacements = [] }) {
  assert(typeof raw === 'string' || Buffer.isBuffer(raw), 'Raw capture bytes are required')
  assert(typeof publicRecordBytes === 'string' || Buffer.isBuffer(publicRecordBytes), 'Public record bytes are required')
  assert(digest(expectedPublicRecordSha256), 'Expected public record hash is required')
  assert.equal(hash(publicRecordBytes), expectedPublicRecordSha256, 'public record hash mismatch')
  const record = JSON.parse(publicRecordBytes.toString())
  assert(digest(record.run?.rawSha256), 'Public record must bind the original raw capture')
  assert.equal(hash(raw), record.run.rawSha256, 'capture hash mismatch')
  assert(Array.isArray(record.actions), 'Public actions are required')
  assert(Array.isArray(replacements), 'Explicit normalization rules are required')
  for (const rule of replacements) assert(Array.isArray(rule) && rule.length === 2 && typeof rule[0] === 'string' && rule[0].startsWith('/') && rule[0].length > 1 && /^\$[A-Z][A-Z0-9_]*$/u.test(rule[1]), 'Normalization must map an absolute prefix to a named placeholder')
  assert.equal(new Set(replacements.map(rule => rule[0])).size, replacements.length, 'Duplicate normalization prefixes')
  const rules = [...replacements].sort((a, b) => b[0].length - a[0].length)
  const expected = record.actions.filter(action => allowed.has(action.type))
  const byId = new Map(expected.map(action => [action.idSha256, action]))
  assert.equal(byId.size, expected.length, 'Duplicate public action identity')
  const actions = [], seen = new Map()
  let identicalCompletedDuplicates = 0
  for (const [index, line] of raw.toString().split('\n').entries()) {
    if (!line.trim()) continue
    const event = JSON.parse(line)
    if (event?.type !== 'item.completed' || !allowed.has(event.item?.type)) continue
    const item = event.item
    assert(typeof item.id === 'string', 'Completed action has no identity')
    const idSha256 = hash(item.id), publicAction = byId.get(idSha256)
    assert(publicAction, 'Completed output is unbound to an existing public action')
    const itemHash = hash(JSON.stringify(item))
    if (seen.has(idSha256)) { assert.equal(seen.get(idSha256), itemHash, 'Conflicting duplicate completed action'); identicalCompletedDuplicates++; continue }
    seen.set(idSha256, itemHash)
    assert.equal(item.type, publicAction.type, 'Action type mismatch')
    assert.equal(item.status, publicAction.status, 'Action status mismatch')
    const output = { idSha256, type: item.type, status: item.status, originalLine: index + 1 }
    if (item.type === 'command_execution') {
      const stdout = typeof item.aggregated_output === 'string' ? item.aggregated_output : null
      assert.equal(stdout === null ? null : hash(stdout), publicAction.outputSha256, 'output hash mismatch')
      assert.equal(stdout === null ? null : Buffer.byteLength(stdout), publicAction.outputBytes, 'output byte length mismatch')
      assert.equal(Number.isInteger(item.exit_code) ? item.exit_code : null, publicAction.exitCode, 'Command exit mismatch')
      Object.assign(output, { outputSha256: publicAction.outputSha256, outputBytes: publicAction.outputBytes, exitCode: publicAction.exitCode, stdout })
    } else {
      const result = encoded(item.result), error = encoded(item.error)
      assert.equal(item.server, publicAction.server, 'MCP server mismatch')
      assert.equal(item.tool, publicAction.tool, 'MCP tool mismatch')
      assert.equal(result === null ? null : hash(result), publicAction.resultSha256, 'result hash mismatch')
      assert.equal(result === null ? null : Buffer.byteLength(result), publicAction.resultBytes, 'result byte length mismatch')
      assert.equal(item.result != null, publicAction.hasResult, 'MCP result presence mismatch')
      assert.equal(item.error != null, publicAction.hasError, 'MCP error presence mismatch')
      Object.assign(output, { server: item.server, tool: item.tool, resultSha256: publicAction.resultSha256, resultBytes: publicAction.resultBytes, errorSha256: error === null ? null : hash(error), result: item.result ?? null, error: item.error ?? null })
    }
    actions.push(output)
  }
  assert.deepEqual(actions.map(action => action.idSha256), expected.map(action => action.idSha256), 'Missing or reordered completed public output')
  const original = { schemaVersion: 1, rawCaptureSha256: record.run.rawSha256, publicRecordSha256: expectedPublicRecordSha256, runId: record.run.id ?? null, identicalCompletedDuplicates, normalization: { rule: 'Longest explicit absolute prefixes first, applied to all JSON keys and string values after original payload binding. Uncovered private machine paths fail closed.', prefixes: rules.map(([prefix, replacement]) => ({ prefixSha256: hash(prefix), replacement })) }, actions, evidenceBoundary: 'Only item.completed command_execution stdout and mcp_tool_call result/error payloads. No agent reasoning, assistant messages, command input, unrelated item fields or file edit bodies. Tool-returned message fields remain tool evidence.' }
  let json = JSON.stringify(original)
  for (const [prefix, replacement] of rules) json = json.replaceAll(prefix, replacement)
  assert(!privatePath.test(json), 'Uncovered private path in supplemental output')
  return JSON.parse(json)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [rawPath, publicPath, expectedHash, replacementsPath, outputPath] = process.argv.slice(2)
  assert(rawPath && publicPath && expectedHash && replacementsPath && outputPath, 'Use RAW PUBLIC EXPECTED_PUBLIC_SHA REPLACEMENTS_JSON NEW_OUTPUT')
  const result = extractToolOutputs({ raw: readFileSync(rawPath), publicRecordBytes: readFileSync(publicPath), expectedPublicRecordSha256: expectedHash, replacements: JSON.parse(readFileSync(replacementsPath)) })
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}
