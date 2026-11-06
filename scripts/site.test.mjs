import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { verifySiteDemo } from './site-demo.mjs'
import { demoHash } from './demo-evidence.mjs'
import { verifyRecordedFixture } from './showcase-fixture.mjs'
import { renderSiteBenchmark, renderHistoricalBenchmark, renderAutomaticBenchmark, verifySiteBenchmark, verifySiteBenchmarkEvidence, verifySiteBenchmarkAnimation, verifySiteBenchmarkFixtures } from './site-benchmark.mjs'
import { summarizePairedRuns } from './paired-agent-evidence.mjs'
import { advertisedInstallCommand } from './site-releasecheck.mjs'
import './site-monorepo-benchmark.test.mjs'
import './site-guided-benchmark.test.mjs'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

test('candidate presentation charges indexing and retains the failed decision gate', () => {
  const report = JSON.parse(read('docs/benchmarks/typelatch-040-candidate/paired-agent.json'))
  const html = renderSiteBenchmark(report)
  assert.match(html, /0\.4\.0 candidate/)
  assert.match(html, /63\.0% higher/)
  assert.match(html, /44\.8% higher/)
  assert.match(html, /Time including indexing/)
  assert.match(html, /463\.3 s/)
  assert.match(html, /320\.0 s/)
  assert.match(html, /did not meet the recorded performance gate/)
  assert.match(html, /5<span> \/ 6/)
  assert.match(html, /4<span> \/ 6/)
  assert.equal((html.match(/data-benchmark-run="/g) || []).length, 12)
  const stale = structuredClone(report)
  stale.decision.passed = true
  assert.throws(() => renderSiteBenchmark(stale), /decision/)
})

test('historical comparison preserves the earlier loss and original replay links', () => {
  const report = JSON.parse(read('docs/benchmarks/typelatch-use/paired-agent.json'))
  const html = renderHistoricalBenchmark(report)
  assert.match(html, /Earlier 0\.3\.0 comparison/)
  assert.match(html, /1,861,666/)
  assert.match(html, /936,683/)
  assert.match(html, /evidence\/typelatch-030\/paired-agent.json/)
  assert.match(html, /evidence\/typelatch-030\/assets\/codex-comparison.gif/)
})

test('README includes npm and the actual question, search and symbol requests', () => {
  const readme = read('README.md')
  const record = JSON.parse(read('docs/showcase/recording.json'))
  assert.ok(readme.includes('https://www.npmjs.com/package/typelatch'), 'direct npm link')
  assert.ok(readme.includes(record.authored.question), 'actual recorded question')
  const requests = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  )
  for (const id of ['refined-search', 'transaction-symbol']) {
    const expected = record.mcp.find((call) => call.id === id).request
    assert.deepEqual(requests.find((request) => request.name === expected.name), expected)
  }
})

test('public onboarding separates the published version from development support', () => {
  const html = read('site/index.html')
  assert.match(html, /Give your agent<br \/>context it<br \/><span>can verify\./)
  assert.doesNotMatch(html, /better first move/i)
  assert.match(html, /Published 0\.3\.0 reads npm, pnpm, Yarn and text Bun lockfiles/)
  assert.match(html, /Deno and binary Bun lockfile support are 0\.4\.0 development additions/)
  assert.match(html, /When a dependency API matters to the change/)
  assert.match(html, /read more only when evidence is missing or stale/)
  assert.match(html, /workspace_validate or native project commands/)
})

test('builds an inspectable static experience from the recorded run', () => {
  assert.ok(
    existsSync(resolve(root, 'scripts/site.mjs')),
    'the static evidence build is implemented',
  )
  execFileSync(process.execPath, ['scripts/site.mjs'], { cwd: root, stdio: 'pipe' })
  const html = read('_site/index.html')
  assert.match(html, /<html lang="en">/)
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1)
  assert.doesNotMatch(html, /\{\{[a-zA-Z]+\}\}/)
  assert.match(html, /https:\/\/www.npmjs.com\/package\/typelatch/)
  assert.ok(html.includes('<code id="hero-install-command">npx typelatch@0.3.0 setup</code>'), 'Onboarding must use the verified exact published release')
  assert.doesNotMatch(html, /New in 0\.4\.0/, 'An unpublished candidate must not be announced as an available release')
  assert.match(html, /Codex or Claude Code CLI/)
  assert.match(html, /library_search/)
  assert.match(html, /workspace_validate/)
  assert.match(html, /TransactionBuilder/)
  assert.match(html, /recorded/i)
  assert.match(html, /not a live/i)
  assert.match(html, /unknown/)
  assert.match(html, /<details/)
  assert.doesNotMatch(html, /\/Users\/|\/private\/var\/|\/var\/folders\//)
  assert.doesNotMatch(html, /[—–]/)
  assert.doesNotMatch(html.replace(/<[^>]*>/gu, ''), /0[123]\s*\//)
  assert.doesNotMatch(html, /LibBrain|Codegraph/i)
  assert.doesNotMatch(html, /class="brand"[^>]*>\s*<img/)
  assert.match(html, /id="hero-install-command"/)
  assert.equal((html.match(/data-demo-scene="/g) || []).length, 6, 'all six scenes exist without JavaScript')
  assert.equal((html.match(/data-demo-step="/g) || []).length, 6, 'all scenes have step navigation')
  assert.match(html, /data-demo-play/)
  assert.match(html, /visual summary of an actual Codex CLI session/)
  const socialImage = html.match(/property="og:image"\s+content="([^"]+)"/)[1]
  assert.ok(
    existsSync(resolve(root, '_site', new URL(socialImage).pathname.replace('/typelatch/', ''))),
    'social image exists',
  )
  assert.deepEqual(
    JSON.parse(read('_site/evidence/recording.json')),
    JSON.parse(read('docs/showcase/recording.json')),
  )
  assert.deepEqual(JSON.parse(read('_site/evidence/codex-session.json')), JSON.parse(read('docs/showcase/codex-session.json')))
  assert.deepEqual(JSON.parse(read('_site/evidence/paired-agent.json')), JSON.parse(read('docs/benchmarks/typelatch-040-candidate/paired-agent.json')))
  assert.equal(read('_site/evidence/paired-agent-protocol.json'), read('docs/benchmarks/typelatch-040-candidate/paired-agent-protocol.json'))
  assert.equal(read('_site/evidence/benchmark-animation.json'), read('site/benchmark-animation.json'))
  assert.match(html, /data-comparison-image/)
  assert.match(html, /Recorded Codex actions, replayed side by side/)
  assert.match(html, /<source media="\(prefers-reduced-motion: reduce\)" srcset="assets\/codex-comparison.png"/)
  const animation = JSON.parse(read('site/benchmark-animation.json'))
  for (const asset of Object.values(animation.assets)) assert.equal(demoHash(readFileSync(resolve(root, '_site', asset.path))), asset.sha256, 'Packaged animation bytes match the selected record manifest')
  for (const run of JSON.parse(read('docs/benchmarks/typelatch-040-candidate/paired-agent.json')).runs) {
    assert.equal(read(`_site/evidence/${run.evidence}`), read(`docs/benchmarks/typelatch-040-candidate/${run.evidence}`), 'Each referenced public run is packaged unchanged')
    assert.equal(demoHash(read(`_site/evidence/${run.evidence}`)), run.evidenceSha256, 'Packaged public run digest matches the report')
  }
  assert.equal(read('_site/evidence/typelatch-030/paired-agent.json'), read('docs/benchmarks/typelatch-use/paired-agent.json'))
  assert.equal(read('_site/evidence/typelatch-030/benchmark-animation.json'), read('site/history/typelatch-030/benchmark-animation.json'))
  const historicalAnimation = JSON.parse(read('site/history/typelatch-030/benchmark-animation.json'))
  for (const asset of Object.values(historicalAnimation.assets)) assert.equal(demoHash(readFileSync(resolve(root, '_site/evidence/typelatch-030', asset.path))), asset.sha256, 'Historical replay bytes are unchanged')
  for (const run of JSON.parse(read('docs/benchmarks/typelatch-use/paired-agent.json')).runs) assert.equal(read(`_site/evidence/typelatch-030/${run.evidence}`), read(`docs/benchmarks/typelatch-use/${run.evidence}`), 'Earlier paired evidence remains unchanged')
  assert.equal(read('_site/evidence/automatic/paired-agent.json'), read('docs/benchmarks/paired-agent.json'))
  assert.equal(read('_site/evidence/automatic/paired-agent-protocol.json'), read('docs/benchmarks/paired-agent-protocol.json'))
  for (const run of JSON.parse(read('docs/benchmarks/paired-agent.json')).runs) assert.equal(read(`_site/evidence/automatic/${run.evidence}`), read(`docs/benchmarks/${run.evidence}`), 'Original automatic choice evidence stays unchanged and separate')
  assert.match(html, /id="benchmark"/)
  assert.equal((html.match(/data-benchmark-run="/g) || []).length, JSON.parse(read('docs/benchmarks/typelatch-040-candidate/paired-agent.json')).runs.length, 'Every primary benchmark session is visible')
  const monorepoDirectory = 'docs/benchmarks/monorepo-agent-study'
  if (existsSync(resolve(root, monorepoDirectory, 'report.json'))) {
    assert.match(html, /id="monorepo-benchmark"/)
    assert.equal((html.match(/data-monorepo-run="/g) || []).length, 16, 'Every maintenance study session is visible')
    assert.deepEqual([...html.matchAll(/data-monorepo-arm="([^"]+)"/g)].map(match => match[1]), ['native', 'competitor', 'typelatch', 'packet'])
    const manifest = JSON.parse(read(`${monorepoDirectory}/manifest.json`))
    for (const file of [...manifest.files, { path: 'manifest.json' }]) assert.equal(read(`_site/evidence/monorepo-agent-study/${file.path}`), read(`${monorepoDirectory}/${file.path}`), 'Every public maintenance artifact is packaged unchanged')
  } else assert.doesNotMatch(html, /id="monorepo-benchmark"/, 'No incomplete study or placeholder result is published')
  const guidedDirectory = 'docs/benchmarks/monorepo-guided-study'
  if (existsSync(resolve(root, guidedDirectory, 'report.json'))) {
    assert.match(html, /id="guided-benchmark"/)
    assert.equal((html.match(/data-guided-run="/g) || []).length, 12, 'Every guided session is visible')
    assert.deepEqual([...html.matchAll(/data-guided-arm="([^"]+)"/g)].map(match => match[1]), ['native', 'competitor', 'packet'])
    const manifest = JSON.parse(read(`${guidedDirectory}/manifest.json`))
    for (const file of [...manifest.files, { path: 'manifest.json' }]) assert.equal(read(`_site/evidence/monorepo-guided-study/${file.path}`), read(`${guidedDirectory}/${file.path}`), 'Every guided evidence artifact is packaged unchanged')
    assert.equal(read('_site/evidence/guided-animation.json'), read('site/guided-animation.json'))
    const replay = JSON.parse(read('site/guided-animation.json'))
    for (const asset of Object.values(replay.assets)) assert.equal(demoHash(readFileSync(resolve(root, '_site', asset.path))), asset.sha256, 'Guided replay bytes match the preselected evidence manifest')
  } else assert.doesNotMatch(html, /id="guided-benchmark"/, 'No guided outcome is invented before export')
  for (const match of html.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
    const link = match[1]
    if (/^(https?:|mailto:|data:)/.test(link)) continue
    assert.ok(!link.startsWith('/'), `project Pages relative URL: ${link}`)
    assert.ok(existsSync(resolve(root, '_site', link)), `local asset exists: ${link}`)
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs are unique')
  for (const match of html.matchAll(/href="#([^"]+)"/g))
    assert.ok(ids.includes(match[1]), `anchor exists: ${match[1]}`)
})

test('repository links and local social images resolve in the correct checkout', () => {
  const documents = [read('site/index.html'), read('README.md'), read('docs/USAGE.md')]
  for (const source of documents) {
    for (const match of source.matchAll(
      /https:\/\/(?:github\.com\/eDimka\/typelatch\/blob|raw\.githubusercontent\.com\/eDimka\/typelatch)\/(?:main|HEAD)\/([^\s"<>\)]+)/g,
    )) {
      const [file, anchor] = match[1].split('#')
      assert.ok(existsSync(resolve(root, file)), `repository target exists: ${file}`)
      if (anchor && file.endsWith('.md')) {
        const headings = [...read(file).matchAll(/^#{1,6} (.+)$/gm)].map((heading) =>
          heading[1]
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s/g, '-'),
        )
        assert.ok(headings.includes(anchor), `repository heading exists: ${file}#${anchor}`)
      }
    }
  }
})

test('refuses a failed recording or historical snapshot changed after capture', () => {
  const directory = mkdtempSync(
    join(process.env.JCODE_SCRATCH_DIR || tmpdir(), 'typelatch-site-contract-'),
  )
  try {
    for (const path of ['scripts', 'docs/showcase/recording.json', 'docs/showcase/recorded-fixture.json']) {
      mkdirSync(resolve(directory, path, '..'), { recursive: true })
      cpSync(resolve(root, path), resolve(directory, path), {
        recursive: true,
        filter: (source) => !source.includes('node_modules'),
      })
    }
    const record = JSON.parse(read('docs/showcase/recording.json'))
    record.assertions.passed = false
    writeFileSync(resolve(directory, 'docs/showcase/recording.json'), JSON.stringify(record))
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/site.mjs'], { cwd: directory, stdio: 'pipe' }),
      /Only a complete verified recording/,
    )
    record.assertions.passed = true
    writeFileSync(resolve(directory, 'docs/showcase/recording.json'), JSON.stringify(record))
    const snapshot = JSON.parse(read('docs/showcase/recorded-fixture.json'))
    snapshot.files.find(file => file.path === 'examples/sqlite/batch.ts').text += '\n// changed after capture\n'
    writeFileSync(resolve(directory, 'docs/showcase/recorded-fixture.json'), JSON.stringify(snapshot))
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/site.mjs'], { cwd: directory, stdio: 'pipe' }),
      /Historical fixture matches recorded execution/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('historical evidence builds independently of the maintained example', () => {
  const directory = mkdtempSync(join(tmpdir(), 'typelatch-site-snapshot-'))
  try {
    for (const path of ['scripts', 'site', 'package.json', 'docs/showcase/recording.json', 'docs/showcase/recorded-fixture.json', 'docs/showcase/codex-session.json', 'docs/benchmarks/paired-agent.json', 'docs/benchmarks/paired-agent-protocol.json', 'docs/benchmarks/paired-agent-runs', 'docs/benchmarks/typelatch-use', 'docs/benchmarks/typelatch-040-candidate', 'docs/benchmarks/monorepo-agent-study', 'docs/benchmarks/monorepo-guided-study']) {
      mkdirSync(resolve(directory, path, '..'), { recursive: true })
      cpSync(resolve(root, path), resolve(directory, path), { recursive: true, filter: source => !source.includes('node_modules') })
    }
    mkdirSync(resolve(directory, 'examples/sqlite'), { recursive: true })
    writeFileSync(resolve(directory, 'examples/sqlite/batch.ts'), 'maintained example changed after historical capture\n')
    execFileSync(process.execPath, ['scripts/site.mjs'], { cwd: directory, stdio: 'pipe' })
    const html = readFileSync(resolve(directory, '_site/index.html'), 'utf8')
    assert.doesNotMatch(html, /maintained example changed/)
    assert.match(html, /export async function importContacts/)
    assert.match(html, /whole batch rollback/)
    assert.match(html, /href="evidence\/recorded-fixture.json"/)
    assert.deepEqual(
      JSON.parse(readFileSync(resolve(directory, '_site/evidence/recorded-fixture.json'), 'utf8')),
      JSON.parse(read('docs/showcase/recorded-fixture.json')),
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a newer source version preserves published onboarding and the captured walkthrough', () => {
  const directory = mkdtempSync(join(tmpdir(), 'typelatch-site-historical-version-'))
  try {
    for (const path of ['scripts', 'site', 'package.json', 'docs/showcase/recording.json', 'docs/showcase/recorded-fixture.json', 'docs/showcase/codex-session.json', 'docs/benchmarks/paired-agent.json', 'docs/benchmarks/paired-agent-protocol.json', 'docs/benchmarks/paired-agent-runs', 'docs/benchmarks/typelatch-use', 'docs/benchmarks/typelatch-040-candidate', 'docs/benchmarks/monorepo-agent-study', 'docs/benchmarks/monorepo-guided-study']) {
      mkdirSync(resolve(directory, path, '..'), { recursive: true })
      cpSync(resolve(root, path), resolve(directory, path), { recursive: true, filter: source => !source.includes('node_modules') })
    }
    const manifest = JSON.parse(read('package.json'))
    const capturedVersion = JSON.parse(read('site/demo.json')).source.packageVersion
    const nextVersion = capturedVersion.replace(/\d+$/, value => String(Number(value) + 1))
    manifest.version = nextVersion
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify(manifest))
    execFileSync(process.execPath, ['scripts/site.mjs'], { cwd: directory, stdio: 'pipe' })
    const html = readFileSync(resolve(directory, '_site/index.html'), 'utf8')
    assert.ok(html.includes(advertisedInstallCommand(read('site/index.html'))), 'Onboarding keeps its exact published pin independently of the checkout version')
    assert.ok(html.includes(`npx typelatch@${capturedVersion} setup`), 'Recorded walkthrough keeps its original identity')
    assert.equal(readFileSync(resolve(directory, '_site/evidence/codex-session.json'), 'utf8'), read('docs/showcase/codex-session.json'))
    assert.equal(readFileSync(resolve(directory, '_site/evidence/demo.json'), 'utf8'), read('site/demo.json'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('historical snapshot rejects missing, additional or altered captured files', () => {
  const snapshot = JSON.parse(read('docs/showcase/recorded-fixture.json'))
  const recording = JSON.parse(read('docs/showcase/recording.json'))
  assert.equal(verifyRecordedFixture(snapshot, recording.fixture).size, recording.fixture.length)
  for (const mutation of [
    value => { value.files.pop() },
    value => { value.files.push(value.files[0]) },
    value => { value.files[0].path = 'examples/sqlite/renamed.ts' },
    value => { value.files[0].text += '\n// altered source' },
    value => { value.files[0].text += '\n// altered source'; value.files[0].sha256 = demoHash(value.files[0].text) },
  ]) {
    const changed = structuredClone(snapshot)
    mutation(changed)
    assert.throws(() => verifyRecordedFixture(changed, recording.fixture))
  }
})

test('static fallback and reduced motion do not depend on animation', () => {
  assert.ok(existsSync(resolve(root, 'site/site.css')), 'site CSS is implemented')
  assert.match(read('site/site.css'), /prefers-reduced-motion:\s*reduce/)
  assert.doesNotMatch(read('site/site.css'), /animation:[^;]*infinite/)
  assert.match(read('site/index.html'), /href="#main"/)
  assert.match(read('site/index.html'), /aria-live="polite"/)
  assert.doesNotMatch(read('site/site.js'), /innerHTML\s*=/)
  assert.match(read('site/site.js'), /clipboard/)
})


test('native walkthrough is bound to successful actions, source identity and the actual edit', () => {
  const capture = read('docs/showcase/codex-session.json')
  const demo = JSON.parse(read('site/demo.json'))
  assert.doesNotThrow(() => verifySiteDemo(capture, demo))
  for (const mutation of [
    value => { value.scenes[1].evidence.actionIndex = 2 },
    value => { value.scenes[3].evidence.request.arguments.symbol = 'invented.API' },
    value => { value.scenes[4].code = 'await db.destroy()' },
    value => { value.scenes[5].code = value.scenes[5].code.replace('# pass 2', '# pass 9') },
  ]) {
    const changed = structuredClone(demo)
    mutation(changed)
    assert.throws(() => verifySiteDemo(capture, changed))
  }
})

test('native walkthrough rejects denied tools, tampered files and manufactured counts', () => {
  const capture = JSON.parse(read('docs/showcase/codex-session.json'))
  const demo = JSON.parse(read('site/demo.json'))
  for (const mutation of [
    value => { value.actions[value.qualified.searchAction].status = 'failed' },
    value => { value.change.after += '\n// changed after capture' },
    value => { value.fixture.after.find(file => file.path === 'package.json').sha256 = 'changed' },
    value => { value.qualified.finalValidationAction = 1 },
    value => { value.counts.mcpCalls = 999 },
  ]) {
    const changed = structuredClone(capture)
    mutation(changed)
    const text = JSON.stringify(changed)
    assert.throws(() => verifySiteDemo(text, { ...demo, source: { ...demo.source, sha256: demoHash(text) } }))
  }
})


test('static command blocks support keyboard scrolling and have accessible names', () => {
  const blocks = [...read('site/index.html').matchAll(/<pre\b([^>]*)>/g)]
  assert.ok(blocks.length > 0)
  for (const [, attributes] of blocks) {
    assert.match(attributes, /\btabindex="0"/, 'Command blocks are reachable for keyboard scrolling')
    assert.match(attributes, /\baria-label="[^"]+"/, 'Command blocks describe their purpose')
  }
})

function samplePairedBenchmark() {
  const counts = { shellCalls: 3, mcpCalls: 0, mcpSucceeded: 0, mcpFailed: 0, fileEdits: 1, grepShellCalls: 1, contentSearchShellCalls: 1, fileListingShellCalls: 0, ambiguousSearchShellCalls: 0 }
  const usage = { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: null, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 120, uncachedInputTokens: 40 }
  const runs = [
    { id: 'example-1-baseline', task: 'example', repeat: 1, arm: 'baseline', elapsedMs: 1000.5, setupMs: 100, indexSetupMs: 0, correct: true, capture: { complete: true }, counts: { ...counts }, usage: { ...usage } },
    { id: 'example-1-typelatch', task: 'example', repeat: 1, arm: 'typelatch', elapsedMs: 2500, setupMs: 100, indexSetupMs: 30, correct: false, capture: { complete: true }, counts: { ...counts, grepShellCalls: 2 }, usage: { ...usage, inputTokens: 200, totalTokens: 220, uncachedInputTokens: 140 } },
  ]
  return { schemaVersion: 1, capturedAt: '2026-11-06T14:00:00Z', protocol: { schemaVersion: 1, model: 'test-model', reasoningEffort: 'medium', repeats: 1, toolPackage: 'typelatch@0.3.0' }, tasks: [{ id: 'example', title: 'Example <fixture>' }], runs, summary: summarizePairedRuns(runs) }
}

test('benchmark presentation includes losses and every run without double counting cached tokens', () => {
  const report = samplePairedBenchmark()
  const html = renderSiteBenchmark(report)
  assert.match(html, /100\.0% higher/)
  assert.match(html, /83\.3% higher/)
  assert.match(html, /149\.9% higher/)
  assert.match(html, /Model token use was 83\.3% higher with Typelatch\. Agent time was 149\.9% higher with Typelatch\./)
  assert.match(html, /benchmark-result-fail">Fail/)
  assert.equal((html.match(/data-benchmark-run="/g) || []).length, 2)
  assert.match(html, /Example &lt;fixture&gt;/)
  assert.match(html, /Fixture preparation/)
  assert.match(html, /Typelatch index preparation/)
  assert.match(html, /Cached input tokens, already included/)
  assert.match(html, /evidence\/paired-agent.json/)
  assert.doesNotMatch(html, /[—–]/)
})

test('benchmark presentation rejects stale aggregates, missing runs and double counted tokens', () => {
  for (const mutate of [
    report => { report.summary.arms.typelatch.correct++ },
    report => { report.runs.pop() },
    report => { report.runs[1].id = report.runs[0].id },
    report => { report.runs[1].arm = 'baseline' },
    report => { report.runs[1].usage.totalTokens += report.runs[1].usage.cachedInputTokens; report.summary = summarizePairedRuns(report.runs) },
    report => { report.runs[1].usage.cachedInputTokens = 201; report.summary = summarizePairedRuns(report.runs) },
  ]) {
    const report = samplePairedBenchmark()
    mutate(report)
    assert.throws(() => verifySiteBenchmark(report))
  }
})

test('benchmark presentation keeps unknown accounting and incomplete captures visible', () => {
  const report = samplePairedBenchmark()
  report.runs[1].correct = null
  report.runs[1].usage = Object.fromEntries(Object.keys(report.runs[1].usage).map(key => [key, null]))
  report.runs[1].capture.complete = false
  report.summary = summarizePairedRuns(report.runs)
  const html = renderSiteBenchmark(report)
  assert.match(html, /Difference unknown/)
  assert.match(html, /benchmark-result-unknown">Unknown/)
  assert.match(html, /class="benchmark-row-typelatch"><th scope="row"><a href="[^"]+">With Typelatch<\/a><\/th><td>Unknown<\/td><td>Unknown<\/td>/)
  assert.match(html, /With Typelatch: 0 failed, 1 unknown/)
})

test('instructed workflow comparison keeps automatic tool choice results separate', () => {
  const automatic = samplePairedBenchmark()
  const automaticHtml = renderAutomaticBenchmark(automatic)
  assert.match(automaticHtml, /0 of 1 Typelatch enabled sessions called its tools/)
  assert.match(automaticHtml, /not pooled/)
  assert.match(automaticHtml, /evidence\/automatic\/paired-agent.json/)
  const primary = samplePairedBenchmark()
  primary.protocol.study = 'explicit-tool-use'
  primary.runs[1].counts.mcpCalls = 4
  primary.runs[1].counts.mcpSucceeded = 4
  primary.summary = summarizePairedRuns(primary.runs)
  const html = renderSiteBenchmark(primary, null, automaticHtml)
  assert.match(html, /identical task and workflow instructions: use Typelatch when available and native tools otherwise/)
  assert.match(html, /1 of 1 Typelatch enabled sessions called its tools/)
  assert.match(html, /0 of 1 Typelatch enabled sessions called its tools/)
  assert.equal((html.match(/data-benchmark-run="/g) || []).length, primary.runs.length)
  assert.throws(() => renderAutomaticBenchmark(primary))
})

function samplePublicBenchmarkEvidence() {
  const report = samplePairedBenchmark()
  report.complete = true
  report.package = { identity: report.protocol.toolPackage }
  report.protocol.tasks = [{ ...report.tasks[0], prompt: 'Fix the isolated example.', promptSha256: demoHash('Fix the isolated example.') }]
  report.protocol.taskCount = report.tasks.length
  report.protocol.runCount = report.runs.length
  report.protocol.schedule = report.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm }))
  const protocolBytes = JSON.stringify(report.protocol, null, 2) + '\n'
  report.protocolSha256 = demoHash(protocolBytes)
  report.fixtureComparisons = {}
  const files = new Map()
  for (const run of report.runs) {
    run.fixtureSha256 = demoHash('identical captured fixture files')
    report.fixtureComparisons[run.id] = { rawManifestSha256: run.fixtureSha256, comparisonSha256: run.fixtureSha256, normalizations: [] }
    run.evidence = `paired-agent-runs/${run.id}.json`
    run.promptSha256 = report.protocol.tasks[0].promptSha256
    const bytes = JSON.stringify({ schemaVersion: 1, run, prompt: report.protocol.tasks[0].prompt }, null, 2) + '\n'
    run.evidenceSha256 = demoHash(bytes)
    files.set(run.evidence, bytes)
  }
  return { report, protocolBytes, files }
}

test('benchmark public evidence binds every packaged run and prompt to the frozen protocol', () => {
  const { report, protocolBytes, files } = samplePublicBenchmarkEvidence()
  const packaged = verifySiteBenchmarkEvidence(report, protocolBytes, path => files.get(path))
  assert.equal(packaged.size, report.runs.length + 1)
  assert.equal(packaged.get('paired-agent-protocol.json'), protocolBytes)
  for (const [path, bytes] of files) assert.equal(packaged.get(path), bytes)
})

test('benchmark public evidence rejects missing or tampered run files and changed prompt identities', () => {
  for (const mutate of [
    value => { value.files.delete(value.report.runs[0].evidence) },
    value => { const path = value.report.runs[0].evidence; value.files.set(path, value.files.get(path) + '\n') },
    value => { value.protocolBytes += '\n' },
    value => { value.report.protocol.model = 'different-model' },
    value => { value.report.complete = false },
    value => { value.report.runs[0].evidence = '../outside.json' },
    value => { value.report.runs[0].correct = false; value.report.summary = summarizePairedRuns(value.report.runs) },
    value => {
      const run = value.report.runs[0], record = JSON.parse(value.files.get(run.evidence))
      record.run.correct = false
      const bytes = JSON.stringify(record)
      value.files.set(run.evidence, bytes); run.evidenceSha256 = demoHash(bytes)
    },
    value => {
      const run = value.report.runs[0], record = JSON.parse(value.files.get(run.evidence))
      record.prompt = 'A different task.'
      const bytes = JSON.stringify(record)
      value.files.set(run.evidence, bytes); run.evidenceSha256 = demoHash(bytes)
    },
  ]) {
    const value = samplePublicBenchmarkEvidence()
    mutate(value)
    assert.throws(() => verifySiteBenchmarkEvidence(value.report, value.protocolBytes, path => value.files.get(path)))
  }
})

test('benchmark fixture comparisons preserve raw identities and reject unmatched task inputs', () => {
  const { report } = samplePublicBenchmarkEvidence()
  assert.doesNotThrow(() => verifySiteBenchmarkFixtures(report))
  for (const mutate of [
    value => { delete value.fixtureComparisons[value.runs[0].id] },
    value => { value.fixtureComparisons[value.runs[0].id].rawManifestSha256 = demoHash('different raw fixture') },
    value => { value.fixtureComparisons[value.runs[0].id].comparisonSha256 = demoHash('different comparison') },
    value => {
      const run = value.runs[0], comparison = value.fixtureComparisons[run.id]
      comparison.normalizations.push({ path: 'src/implementation.ts', rawSha256: demoHash('original'), comparisonSha256: demoHash('changed'), replacements: 1, aliasReplacementCounts: [1] })
    },
  ]) {
    const changed = structuredClone(report)
    mutate(changed)
    assert.throws(() => verifySiteBenchmarkFixtures(changed))
  }
})

function sampleBenchmarkAnimation() {
  const report = samplePairedBenchmark()
  report.tasks[0].id = 'sqlite-rollback'
  for (const run of report.runs) {
    run.task = 'sqlite-rollback'
    run.evidenceSha256 = demoHash(run.id)
  }
  report.summary = summarizePairedRuns(report.runs)
  const files = new Map([
    ['assets/codex-comparison.gif', Buffer.from('GIF89a')],
    ['assets/codex-comparison.png', Buffer.from('89504e470d0a1a0a', 'hex')],
  ])
  const animation = {
    schemaVersion: 1, task: 'sqlite-rollback', repeat: 1,
    runs: report.runs.map(({ id, evidenceSha256 }) => ({ id, evidenceSha256 })),
    assets: Object.fromEntries([['gif', 'gif'], ['poster', 'png']].map(([kind, extension]) => {
      const path = `assets/codex-comparison.${extension}`
      return [kind, { path, sha256: demoHash(files.get(path)) }]
    })),
  }
  const source = { reportBytes: JSON.stringify(report, null, 2) + '\n', rendererBytes: 'test renderer source\n' }
  animation.reportSha256 = demoHash(source.reportBytes)
  animation.rendererSha256 = demoHash(source.rendererBytes)
  return { report, animation, files, source }
}

test('comparison replay binds the preselected actual pair and has an accessible static fallback', () => {
  const { report, animation, files, source } = sampleBenchmarkAnimation()
  verifySiteBenchmarkAnimation(report, animation, path => files.get(path), source)
  const html = renderSiteBenchmark(report, animation)
  assert.match(html, /data-comparison-play aria-controls="comparison-replay" aria-pressed="false" hidden/)
  assert.match(html, /src="assets\/codex-comparison.png"/)
  assert.match(html, /data-gif="assets\/codex-comparison.gif"/)
  assert.match(html, /<source media="\(prefers-reduced-motion: reduce\)"/)
  assert.match(html, /Separate sessions aligned at start; playback accelerated/)
  assert.match(html, /action replay, not a screen recording/)
  for (const run of animation.runs) assert.match(html, new RegExp(`evidence/paired-agent-runs/${run.id}.json`))
})

test('comparison replay rejects a different selected pair or stale generated assets', () => {
  for (const mutate of [
    value => { value.animation.repeat = 2 },
    value => { value.animation.task = 'different-task' },
    value => { value.animation.runs.reverse() },
    value => { value.animation.runs[0].evidenceSha256 = 'different' },
    value => { value.files.set('assets/codex-comparison.gif', Buffer.from('changed')) },
    value => { value.files.delete('assets/codex-comparison.png') },
    value => { value.animation.assets.poster.path = 'assets/other.png' },
  ]) {
    const value = sampleBenchmarkAnimation()
    mutate(value)
    assert.throws(() => verifySiteBenchmarkAnimation(value.report, value.animation, path => value.files.get(path), value.source))
  }
})

test('comparison replay binds the exact report and renderer bytes', () => {
  const original = sampleBenchmarkAnimation()
  assert.doesNotThrow(() => verifySiteBenchmarkAnimation(original.report, original.animation, path => original.files.get(path), original.source))
  for (const mutate of [
    value => { value.animation.reportSha256 = demoHash('another report') },
    value => { value.source.reportBytes += '\n' },
    value => { value.animation.rendererSha256 = demoHash('another renderer') },
    value => { value.source.rendererBytes += '# changed\n' },
    value => {
      const changed = structuredClone(value.report)
      changed.protocol.model = 'another-model'
      value.source.reportBytes = JSON.stringify(changed)
      value.animation.reportSha256 = demoHash(value.source.reportBytes)
    },
  ]) {
    const value = sampleBenchmarkAnimation()
    mutate(value)
    assert.throws(() => verifySiteBenchmarkAnimation(value.report, value.animation, path => value.files.get(path), value.source))
  }
})
