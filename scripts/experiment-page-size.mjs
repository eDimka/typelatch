import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = resolve('artifacts/competitive/page-size', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(directory, { recursive: true })
const hash = text => createHash('sha256').update(text).digest('hex')
const walk = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)])
const shared = resolve('scripts/fixtures/competitive')
const fixtures = [
  { name: 'tiny', files: [{ path: 'index.ts', text: 'export const freshMarker = true\n' }], queries: ['freshMarker', 'missingNeedle'] },
  { name: 'shared', files: walk(shared).map(path => ({ path: relative(shared, path), text: readFileSync(path, 'utf8') })), queries: ['calculateInvoiceTotal', 'retryDelay', 'invoice total after tax'] },
  { name: 'repository', files: walk(resolve('src')).map(path => ({ path: relative(resolve('.'), path), text: readFileSync(path, 'utf8') })), queries: ['validateWorkspace', 'timeout command output', 'cursor definitions references', 'missingNeedle'] },
  { name: 'generated', files: Array.from({ length: 80 }, (_, i) => ({ path: `src/service${i}.ts`, text: Array.from({ length: 40 }, (_, j) => `/** Validate incoming request ${j} and preserve its payload before dispatch. */\nexport function validateRequest${i}_${j}(payload: string): string {\n  return payload.trim()\n}\n`).join('\n') })), queries: ['validateRequest42_12', 'validate incoming payload', 'missingNeedle'] }
]
const rows = []
const expected = new Map()
const previousHome = process.env.TYPELATCH_HOME
try {
  for (const pageSize of [4096, 2048, 1024, 512]) {
    const build = join(directory, `dist-${pageSize}`)
    cpSync('dist', build, { recursive: true })
    const module = join(build, 'workspace/search-index.js')
    const text = readFileSync(module, 'utf8')
    assert(text.includes('db.pragma("busy_timeout = 5000");'))
    writeFileSync(module, text.replace('db.pragma("busy_timeout = 5000");', `db.pragma("page_size = ${pageSize}");\n    db.pragma("busy_timeout = 5000");`))
    const { searchWorkspaceIndex } = await import(pathToFileURL(module))
    process.env.TYPELATCH_HOME = join(directory, `cache-${pageSize}`)
    for (const fixture of fixtures) {
      const root = join(directory, 'corpus', fixture.name)
      const files = fixture.files.map(item => ({ ...item, path: join(root, item.path), hash: hash(item.text), searchable: true }))
      const start = performance.now()
      const first = searchWorkspaceIndex(root, files, fixture.queries[0], new AbortController().signal)
      const buildMs = performance.now() - start
      const timings = []
      for (let round = 0; round < 8; round++) for (const question of fixture.queries) {
        const start = performance.now()
        const response = searchWorkspaceIndex(root, files, question, new AbortController().signal)
        timings.push(performance.now() - start)
        const key = `${fixture.name}:${question}`
        if (!expected.has(key)) expected.set(key, response.candidates)
        assert.deepEqual(response.candidates, expected.get(key))
      }
      timings.sort((a, b) => a - b)
      rows.push({ pageSize, corpus: fixture.name, files: files.length, bytes: statSync(first.index.path).size, buildMs, medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.ceil(timings.length * .95) - 1], parity: true })
    }
  }
} finally {
  if (previousHome === undefined) delete process.env.TYPELATCH_HOME
  else process.env.TYPELATCH_HOME = previousHome
}
const report = { generatedAt: new Date().toISOString(), kind: 'Experimental SQLite page sizes with full candidate parity', limitations: 'Sequential local microbenchmark on authored fixtures. Not agent or competitor proof. No source default is changed by this script.', rows }
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
