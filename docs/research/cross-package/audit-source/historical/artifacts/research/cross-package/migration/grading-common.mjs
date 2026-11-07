import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'

export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function runCheck(script, workspace) {
  const startedAt = new Date().toISOString(), start = performance.now()
  const r = spawnSync(process.execPath, [script, workspace], { cwd: workspace, env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
  let result = null
  try { result = JSON.parse(r.stdout.trim()) } catch {}
  return { startedAt, elapsedMs: performance.now() - start, exitCode: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, result, error: r.error?.message ?? null }
}
export function sourceManifest(workspace) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: workspace, encoding: 'utf8' }); assert.equal(r.status, 0)
  const tracked = new Set(r.stdout.split('\0').filter(Boolean))
  const all = inventoryTree(workspace)
  const entries = all.entries.filter(row => tracked.has(row.path))
  assert.equal(entries.length, tracked.size)
  return { root: workspace, entries, sha256: sha(JSON.stringify(entries)) }
}
export function integrity(initial, current, tracking) {
  const tracked = new Set(tracking.entries.map(row => row.path))
  const generated = new Set(tracking.entries.filter(row => /(^|\/)tsconfig\.json$/.test(row.path)).map(row => dirname(row.path)))
  function output(path) {
    if (tracked.has(path) || path.split('/').includes('node_modules')) return false
    return [...generated].some(dir => path === `${dir}/tsconfig.tsbuildinfo` || path === `${dir}/lib` || path.startsWith(`${dir}/lib/`))
  }
  const a = new Map(initial.entries.filter(row => row.kind !== 'directory').map(row => [row.path, row])), b = new Map(current.entries.filter(row => row.kind !== 'directory').map(row => [row.path, row]))
  const changed = [], forbidden = [], generatedChanged = []
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(path), after = b.get(path)
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    if (output(path)) { generatedChanged.push(path); continue }
    changed.push(path)
    if (!tracked.has(path) || !before || !after || before.kind !== 'file' || after.kind !== 'file' || before.mode !== after.mode || !/(^|\/)src\/.+\.ts$/.test(path) || /(^|\/)(?:test|tests|__tests__|node_modules)\//.test(path) || /\.(?:test|spec|d)\.ts$/.test(path)) forbidden.push(path)
  }
  return { passed: forbidden.length === 0, changed: changed.sort(), forbidden: forbidden.sort(), generatedChanged: generatedChanged.sort(), policy: 'Only existing tracked production TypeScript source may change. Build outputs under declared project lib directories and tsconfig.tsbuildinfo are disposable and rebuilt from source before checks. Dependencies, manifests, tests and configuration are immutable.' }
}
export function grade(workspace, initial, trackingPath, script, expectedCases) {
  const tracking = JSON.parse(readFileSync(trackingPath)), before = inventoryTree(workspace), guard = integrity(initial, before, tracking)
  const checks = guard.passed ? runCheck(script, workspace) : null
  const after = inventoryTree(workspace), afterGuard = integrity(initial, after, tracking)
  const sourceStable = JSON.stringify(guard.changed.map(path => before.entries.find(row => row.path === path))) === JSON.stringify(afterGuard.changed.map(path => after.entries.find(row => row.path === path)))
  return { passed: guard.passed && afterGuard.passed && sourceStable && checks?.exitCode === 0 && checks.result?.passed === true && checks.result.cases === expectedCases, integrity: guard, sourceStable, checks }
}
