import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'

const here = import.meta.dirname
const repository = resolve(here, '../../../..')
const original = join(repository, 'artifacts/research/large-monorepo/pnpm-source')
const pnpm = join(repository, 'artifacts/research/large-monorepo/tools/pnpm/node_modules/pnpm/bin/pnpm.cjs')
export const targets = ['cache/api', 'fs/find-packages', 'patching/plugin-commands-patching', 'pkg-manager/package-bins', 'releasing/plugin-commands-publishing']
export const sources = ['cache/api/src/cacheList.ts', 'cache/api/src/cacheView.ts', 'fs/find-packages/src/index.ts', 'patching/plugin-commands-patching/src/patchCommit.ts', 'pkg-manager/package-bins/src/index.ts', 'releasing/plugin-commands-publishing/src/pack.ts']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
function run(command, args, cwd, env = {}, timeout = 300000) {
  const startedAt = new Date().toISOString(), start = performance.now()
  const r = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 })
  return { command, args, startedAt, elapsedMs: performance.now() - start, exitCode: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message ?? null }
}
export function prepare(output) {
  assert(!existsSync(output), 'Retain every attempt in a new directory')
  mkdirSync(output, { recursive: true })
  const record = { status: 'preparing', sourceCommit: 'eaae772717d3d36903960af125a2a2ff9d34fe09', upstreamMigration: 'b8b0c687f2e3403d07381822fe81c08478413916', targets, sources, steps: [] }
  const persist = () => write(join(output, 'preparation.json'), record)
  persist()
  try {
    const before = inventoryTree(original, { excludeDirectories: ['.git', '.typelatch'] })
    write(join(output, 'upstream-source-manifest.json'), before)
    const workspace = join(output, 'workspace')
    const copy = run('cp', ['-cR', original, workspace], here); record.steps.push(copy); assert.equal(copy.exitCode, 0)
    // macOS cp may resolve symlink aliases. Restore committed link text exactly.
    record.symlinkRestorations = []
    for (const row of before.entries.filter(row => row.kind === 'symlink')) {
      const path = join(workspace, row.path), actual = readlinkSync(path)
      if (actual !== row.target) { record.symlinkRestorations.push({ path: row.path, before: actual, after: row.target }); rmSync(path); symlinkSync(row.target, path) }
    }
    assert.equal(inventoryTree(workspace).sha256, before.sha256)
    const installHome = join(output, 'install-home'); mkdirSync(installHome)
    const config = join(installHome, 'empty.npmrc'); writeFileSync(config, '')
    const names = targets.map(path => JSON.parse(readFileSync(join(workspace, path, 'package.json'))).name)
    const install = run(process.execPath, [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(here, 'dependency-store'), '--config.enableGlobalVirtualStore=false', '--config.managePackageManagerVersions=false', '--config.cleanupUnusedCatalogs=false', '--filter=monorepo-root', ...names.map(name => `--filter=${name}...`), '--reporter=append-only'], workspace, { HOME: installHome, XDG_CONFIG_HOME: join(installHome, 'config'), XDG_CACHE_HOME: join(installHome, 'cache'), npm_config_userconfig: config, CI: '1' })
    record.steps.push(install); persist(); assert.equal(install.exitCode, 0, 'Frozen install failed')
    for (const row of before.entries.filter(row => row.kind === 'file')) assert.equal(sha(readFileSync(join(workspace, row.path))), row.sha256, `Install changed original source: ${row.path}`)
    const build = run(process.execPath, [join(workspace, 'node_modules/typescript/bin/tsc'), '-b', ...targets], workspace)
    record.steps.push(build); persist(); assert.equal(build.exitCode, 0, 'Unchanged reference native build failed')
    record.referenceSources = sources.map(path => ({ path, sha256: sha(readFileSync(join(workspace, path))) }))
    mkdirSync(join(output, 'reference-sources'))
    sources.forEach((path, i) => cpSync(join(workspace, path), join(output, 'reference-sources', `${i}.ts`)))
    record.status = 'reference-ready'; record.workspace = workspace; record.completedAt = new Date().toISOString(); persist()
    return { status: record.status, workspace, installMs: install.elapsedMs, buildMs: build.elapsedMs }
  } catch (e) { record.status = 'preparation-failed'; record.error = e.message; persist(); throw e }
}
if (process.argv[2] === '--prepare') console.log(JSON.stringify(prepare(resolve(process.argv[3]))))
