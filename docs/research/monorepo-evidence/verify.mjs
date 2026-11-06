import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
const root = import.meta.dirname
const sha = x => createHash('sha256').update(x).digest('hex')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json')))
const decoded = new Map(), byOriginal = new Map()
for (const entry of manifest.files) {
  const bytes = readFileSync(resolve(root, entry.path))
  assert.equal(sha(bytes), entry.sha256, entry.path + ': export hash')
  const plain = entry.path.endsWith('.gz') ? gunzipSync(bytes) : bytes
  if (entry.decodedSha256) assert.equal(sha(plain), entry.decodedSha256, entry.path + ': decoded hash')
  decoded.set(entry.path, plain.toString())
  if (entry.originalSha256) byOriginal.set(entry.originalSha256, entry.path)
  assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(plain.toString()), entry.path + ': private path')
}
const json = path => JSON.parse(decoded.get(path))
const pointer = (value, path) => path.split('/').slice(1).reduce((v, key) => v[key.replaceAll('~1', '/').replaceAll('~0', '~')], value)
let citations = 0
const summaries = {}
for (const file of ['screen004/benchmark-tasks-core-round1.json', 'screen004/benchmark-tasks-competitors-round1.json']) {
  const ledger = json(file)
  for (const [provider, facts] of Object.entries(ledger.facts)) {
    assert.equal(facts.length, 35)
    assert.equal(new Set(facts.map(f => f.probeId + ':' + f.factId)).size, 35)
    const raw = json('screen004/' + provider + '.json.gz')
    for (const fact of facts) {
      for (const citation of fact.citations) {
        const path = byOriginal.get(citation.rawArtifactSha256)
        assert(path, 'Missing original capture hash ' + citation.rawArtifactSha256)
        const value = pointer(json(path), citation.jsonPointer)
        assert((typeof value === 'string' ? value : JSON.stringify(value)).includes(citation.exactQuote), file + ': citation ' + citation.jsonPointer)
        citations++
      }
    }
    const ids = [...new Set(facts.map(f => f.probeId))]
    const eligible = id => raw.probes.filter(p => p.id === id).every(p => p.status === 'completed' && p.actionCount <= 8 && p.textBytes <= 65536 && p.elapsedMs <= 60000)
    const supported = facts.filter(f => f.state === 'supported')
    summaries[provider] = { rawSupportedFacts: supported.length, qualifiedFacts: supported.filter(f => eligible(f.probeId)).length, completeProbes: ids.filter(id => eligible(id) && facts.filter(f => f.probeId === id).every(f => f.state === 'supported')).length }
  }
}
const cases = json('local-ranking/ranker-cases.json').cases
const ranking = {}
for (const id of ['mlx-1', 'mlx-2', 'ollama-1', 'ollama-2']) {
  const report = json('local-ranking/' + id + '.json')
  assert.equal(report.cases.length, cases.length)
  let hits = 0, reciprocalRank = 0, absentRecognized = 0, positives = 0, absent = 0
  for (const c of cases) {
    const result = report.cases.find(r => r.id === c.id)
    assert(result && result.status === 'ok', id + ': case incomplete')
    const top = result.rankedIds.slice(0, 2)
    if (c.relevantIds.length) { positives++; const rank = top.findIndex(v => c.relevantIds.includes(v)); if (rank >= 0) { hits++; reciprocalRank += 1 / (rank + 1) } }
    else { absent++; if (result.rankedIds.length === 0) absentRecognized++ }
  }
  ranking[id] = { positives, hitsAt2: hits, MRRAt2: reciprocalRank / positives, absent, absentRecognized }
}
console.log(JSON.stringify({ filesVerified: manifest.files.length, exactCitationsVerified: citations, toolScreen: summaries, localRanking: ranking, limit: 'Hash and arithmetic verification does not independently establish the semantic correctness of manual fact labels or reproduce model behavior.' }, null, 2))
