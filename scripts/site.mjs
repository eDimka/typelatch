import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '_site')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const recording = JSON.parse(read('docs/showcase/recording.json'))
const call = (id) => {
  const value = recording.mcp.find((item) => item.id === id)
  assert.ok(value && !value.response.isError, `Recorded MCP call exists: ${id}`)
  return value
}
const result = (id) => call(id).response.structuredContent
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
const code = (value, label = 'Recorded JSON', highlight = '') =>
  `<pre tabindex="0" aria-label="${escape(label)}"><code>${String(value)
    .split('\n')
    .map((line) =>
      highlight && line.includes(highlight)
        ? `<span class="code-focus">${escape(line)}</span>`
        : escape(line),
    )
    .join('\n')}</code></pre>`
const json = (value, label) => code(JSON.stringify(value, null, 2), label)
const rawLink = (id, text = 'Full request and response') =>
  `<a href="evidence/${id}.json">${escape(text)} <span aria-hidden="true">↗</span></a>`

assert.equal(
  recording.assertions.passed,
  true,
  'Only a complete verified recording can be published',
)
assert.equal(recording.provenance.publishedPackage, 'typelatch@0.1.1')
assert.equal(recording.provenance.indexedPackage, 'kysely@0.28.8')
for (const file of recording.fixture) {
  const hash = createHash('sha256')
    .update(readFileSync(resolve(root, file.path)))
    .digest('hex')
  assert.equal(hash, file.sha256, `Fixture matches recorded execution: ${file.path}`)
}
const transaction = result('transaction-symbol').results.find(
  (item) => item.symbol === 'esm/kysely.TransactionBuilder',
)
assert.ok(transaction)
assert.equal(transaction.line, 623)
const positive = result('validate-positive')
const negative = result('validate-negative')
const context = result('workspace-context')
assert.equal(positive.checks.typechecked.status, 'pass')
assert.equal(positive.checks.tested.status, 'pass')
assert.equal(positive.checks.stable.status, 'pass')
assert.equal(positive.execution.exitCode, 0)
assert.equal(negative.checks.typechecked.status, 'pass')
assert.equal(negative.checks.tested.status, 'fail')
assert.equal(negative.execution.exitCode, 1)
assert.equal(context.checks.artifactMatch.status, 'unknown')

const testNames = [...positive.execution.stdout.matchAll(/^ok \d+ - (.+)$/gm)].map(
  (match) => match[1],
)
assert.equal(testNames.length, 2)
const batch = read('examples/sqlite/batch.ts')
const implementation = batch.slice(batch.indexOf('export async function importContacts')).trimEnd()
assert.ok(implementation.startsWith('export async function importContacts'))
const store = recording.storeAudit[0]
const storeLookup = store.queries.find((query) => query.sql.includes('WHERE qualified_name = ?'))
assert.equal(storeLookup.rows[0].qualified_name, transaction.symbol)
const initial = result('initial-search')
const testSource = read('examples/sqlite/batch.test.ts')
const assertionProofs = testNames
  .map((name, index) => {
    const start = testSource.indexOf(`test('${name}'`)
    assert.ok(start >= 0, 'Recorded test name exists in the hash matched fixture')
    const next = testSource.indexOf("\ntest('", start + 1)
    const source = testSource.slice(start, next < 0 ? undefined : next).trimEnd()
    const id = index === 0 ? 'binding-proof' : 'rollback-proof'
    const diagnostic =
      index === 0 ? 'parameter binding and exact round trip' : 'whole batch rollback'
    const stdout = positive.execution.stdout
      .split('\n')
      .filter(
        (line) =>
          line === `ok ${index + 1} - ${name}` ||
          (line.startsWith('# {') && line.includes(diagnostic)),
      )
      .join('\n')
    assert.ok(stdout.includes(`ok ${index + 1}`))
    return `<details class="assertion-detail" id="${id}" tabindex="-1"><summary>${escape(name)} <span class="state-pass">pass</span></summary><p>Executed assertion source from <code>batch.test.ts</code>:</p>${code(source, 'Executed assertion source')}<p>Exact recorded stdout excerpt:</p>${code(stdout, 'Recorded assertion stdout excerpt')}${rawLink('validate-positive', 'Complete validation request and response')}</details>`
  })
  .join('')

const replacements = {
  recordDate: escape(
    new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })
      .format(new Date(recording.provenance.capturedAt))
      .toUpperCase(),
  ),
  question: escape(recording.authored.question),
  recordedOutcomes: `<div class="recorded-outcomes"><p class="small-label">ACTUAL RESULTS IN THIS FIXTURE</p><div><a href="#use" data-next-view="use"><span class="state-pass">${escape(positive.checks.typechecked.status)}</span> Compiler check <span aria-hidden="true">↗</span></a><a href="#binding-proof" data-proof="binding-proof"><span class="state-pass">pass</span> Quoted names preserved <span aria-hidden="true">↗</span></a><a href="#rollback-proof" data-proof="rollback-proof"><span class="state-pass">pass</span> Failed batch rolled back <span aria-hidden="true">↗</span></a></div></div>`,
  initialSearch: `<details><summary>Inspect the initial question and returned APIs</summary>${json(call('initial-search').request, 'Initial MCP search request')}<p>Returned symbols and source locations, in recorded order:</p><ul class="result-list">${initial.results.map((item) => `<li>${escape(item.symbol)}<small>${escape(item.source)}:${item.line}</small></li>`).join('')}</ul>${rawLink('initial-search')}</details>`,
  refinedRequest: json(
    call('refined-search').request.arguments,
    'Refined library_search arguments',
  ),
  sourceSignature: code(
    transaction.signature,
    'Exact returned TransactionBuilder declaration',
    'execute<T>',
  ),
  sourceReference: `<a href="https://unpkg.com/kysely@0.28.8/${escape(transaction.source)}">${escape(transaction.source)} · line ${transaction.line} <span aria-hidden="true">↗</span></a>`,
  symbolRequest: `<details><summary>Inspect the exact symbol request</summary>${json(call('transaction-symbol').request, 'Exact library_symbol request')}${rawLink('transaction-symbol')}</details>`,
  storeAudit: `<details><summary>Inspect the read only SQLite store audit</summary><p>A separate audit queried this file after the MCP lookup. This is recorded SQL inspection, not an arbitrary SQL MCP tool.</p>${code(store.path, 'Recorded SQLite database path')}${json(storeLookup, 'Actual read only SQLite audit query and returned row')}<a href="evidence/store-audit.json">Full store audit, schema and counts <span aria-hidden="true">↗</span></a></details>`,
  implementation: code(
    implementation,
    'Executed importContacts source excerpt',
    'db.transaction().execute',
  ),
  workspaceContext: `<div class="context-strip"><p><strong>Before validation:</strong> <code>workspace_context</code> resolved Kysely 0.28.8 in the installed project. Artifact match: <strong>${escape(context.checks.artifactMatch.status)}</strong>.</p><details><summary>Inspect the context request and evidence</summary>${json(call('workspace-context').request, 'Actual workspace_context request')}${json(context.checks, 'Returned context evidence states')}${rawLink('workspace-context')}</details></div>`,
  validationRequest: json(
    call('validate-positive').request.arguments,
    'Actual workspace_validate arguments',
  ),
  evidenceStates: `<dl class="evidence-states">${[
    ['typechecked', 'TypeScript compilation'],
    ['tested', 'Explicit test command'],
    ['stable', 'Recorded inputs unchanged'],
  ]
    .map(
      ([key, label]) =>
        `<div><dt>${label}</dt><dd class="state-${positive.checks[key].status}">${escape(positive.checks[key].status)}</dd></div>`,
    )
    .join('')}</dl>${rawLink('validate-positive', 'Inspect the validation result')}`,
  assertionOutput: `${assertionProofs}<p class="annotation">Exact test names from the recorded output. Open either assertion to inspect its source and result. Exit code ${positive.execution.exitCode}.</p>`,
  executionOutput:
    code(positive.execution.stdout, 'Complete captured test stdout') +
    (positive.execution.stderr
      ? code(positive.execution.stderr, 'Complete captured test stderr')
      : ''),
  negativeResult: `<div class="negative-evidence"><div>compile <strong>${escape(negative.checks.typechecked.status)}</strong></div><div>assertion <strong class="state-fail">${escape(negative.checks.tested.status)}</strong></div>${rawLink('validate-negative', 'Inspect failing control')}</div>`,
}
let html = read('site/index.html').replace(/\{\{(\w+)\}\}/g, (_, key) => {
  assert.ok(Object.hasOwn(replacements, key), `Known template value: ${key}`)
  return replacements[key]
})
assert.doesNotMatch(html, /\{\{\w+\}\}/)
assert.doesNotMatch(html, /\/Users\/|\/private\/var\/|\/var\/folders\//)

// This directory is generated only by this script, never a source directory.
rmSync(output, { recursive: true, force: true })
mkdirSync(resolve(output, 'evidence'), { recursive: true })
for (const asset of ['assets', 'site.css', 'site.js'])
  cpSync(resolve(root, 'site', asset), resolve(output, asset), { recursive: true })
writeFileSync(resolve(output, 'index.html'), html)
writeFileSync(resolve(output, '.nojekyll'), '')
cpSync(resolve(root, 'docs/showcase/recording.json'), resolve(output, 'evidence/recording.json'))
for (const item of recording.mcp)
  writeFileSync(resolve(output, `evidence/${item.id}.json`), JSON.stringify(item, null, 2) + '\n')
writeFileSync(
  resolve(output, 'evidence/store-audit.json'),
  JSON.stringify(recording.storeAudit, null, 2) + '\n',
)
writeFileSync(
  resolve(output, 'robots.txt'),
  'User-agent: *\nAllow: /\nSitemap: https://edimka.github.io/typelatch/sitemap.xml\n',
)
writeFileSync(
  resolve(output, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://edimka.github.io/typelatch/</loc></url></urlset>\n',
)
console.log(
  'Built _site from the complete recording. Exact package identities, fixture hashes, and displayed evidence states verified.',
)
