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

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

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
  assert.match(html, /npm install --global typelatch@0\.1\.1/)
  const agentPrompt = html.match(/<p id="agent-prompt">([\s\S]*?)<\/p>/)[1]
  assert.match(agentPrompt, /library_search/)
  assert.doesNotMatch(agentPrompt, /workspace_search/)
  assert.match(html, /codex mcp add typelatch -- typelatch-mcp/)
  assert.match(html, /claude mcp add --transport stdio --scope user typelatch -- typelatch-mcp/)
  assert.match(html, /library_search/)
  assert.match(html, /workspace_validate/)
  assert.match(html, /TransactionBuilder/)
  assert.match(html, /recorded/i)
  assert.match(html, /not a live/i)
  assert.match(html, /unknown/)
  assert.match(html, /<details/)
  assert.doesNotMatch(html, /\/Users\/|\/private\/var\/|\/var\/folders\//)
  assert.doesNotMatch(html, /[—–]/)
  assert.doesNotMatch(html, /0[123]\s*\//)
  assert.doesNotMatch(html, /LibBrain|Codegraph/i)
  assert.doesNotMatch(html, /class="brand"[^>]*>\s*<img/)
  assert.match(html, /id="hero-install-command"/)
  const socialImage = html.match(/property="og:image"\s+content="([^"]+)"/)[1]
  assert.ok(
    existsSync(resolve(root, '_site', new URL(socialImage).pathname.replace('/typelatch/', ''))),
    'social image exists',
  )
  assert.deepEqual(
    JSON.parse(read('_site/evidence/recording.json')),
    JSON.parse(read('docs/showcase/recording.json')),
  )
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

test('refuses a failed recording or a fixture that changed after capture', () => {
  const directory = mkdtempSync(
    join(process.env.JCODE_SCRATCH_DIR || tmpdir(), 'typelatch-site-contract-'),
  )
  try {
    for (const path of ['scripts/site.mjs', 'docs/showcase/recording.json', 'examples/sqlite']) {
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
    writeFileSync(resolve(directory, 'examples/sqlite/batch.ts'), 'changed after capture\n')
    assert.throws(
      () => execFileSync(process.execPath, ['scripts/site.mjs'], { cwd: directory, stdio: 'pipe' }),
      /Fixture matches recorded execution/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
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
