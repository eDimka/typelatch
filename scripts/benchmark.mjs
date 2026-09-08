import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { platform, arch, cpus } from 'node:os'
import { loadCorpus, corpusCaseFile } from '../dist/benchmark/corpus.js'
import { buildBrain } from '../dist/indexer.js'
import { runBenchmark } from '../dist/benchmark.js'

process.env.TYPELATCH_HOME ??= resolve('.typelatch')
process.env.TYPELATCH_USAGE = 'off'
const reports = []
const limitations = JSON.parse(readFileSync('src/benchmark/limitations.json', 'utf8'))
const accepted = (row, result) => {
  if (result.found.length === 0) return false
  if (result.passed) return true
  const known = limitations.find(item => item.package === row.package && item.version === row.version && item.question === result.question && JSON.stringify(item.expected) === JSON.stringify(result.expected))
  return !!known && result.expected.filter(symbol => !result.found.includes(symbol)).every(symbol => known.missing.includes(symbol))
}
for (const entry of loadCorpus().packages) {
  console.error(`${entry.name}@${entry.version}`)
  const built = await buildBrain(`${entry.name}@${entry.version}`)
  if (built.metadata.integrity !== entry.integrity) throw new Error(`Integrity mismatch: ${entry.name}`)
  reports.push(runBenchmark(entry.name, corpusCaseFile(entry.name), { version: entry.version }))
}
const report = {
  generatedAt: new Date().toISOString(),
  kind: 'authored retrieval regression',
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  packages: reports.length,
  cases: reports.reduce((sum, row) => sum + row.cases, 0),
  passedCases: reports.reduce((sum, row) => sum + row.passedCases, 0),
  discoveryHits: reports.flatMap(row => row.results).filter(row => row.found.length > 0).length,
  acceptance: {
    discovery: 'Every question returns at least one expected symbol in the first five results',
    knownLimitations: limitations
  },
  reports
}
mkdirSync('docs/benchmarks', { recursive: true })
writeFileSync('docs/benchmarks/retrieval.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ packages: report.packages, cases: report.cases, passedCases: report.passedCases }))
if (reports.some(row => row.results.some(result => !accepted(row, result)))) process.exitCode = 1
