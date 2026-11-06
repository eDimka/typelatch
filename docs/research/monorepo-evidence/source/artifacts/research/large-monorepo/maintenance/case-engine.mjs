import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runCases(cases) {
  const workspace = resolve(process.cwd())
  const module = await import(pathToFileURL(join(workspace, 'workspace/filter-workspace-packages/src/getChangedPackages.ts')).href)
  const getChangedPackages = module.getChangedPackages ?? module.default?.getChangedPackages
  assert.equal(typeof getChangedPackages, 'function', 'Real workspace implementation must load')
  const results = []
  for (const scenario of cases) {
    const root = mkdtempSync(join(tmpdir(), 'typelatch-pnpm-maintenance-'))
    const git = args => {
      const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', root, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid', GIT_COMMITTER_NAME: 'Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })
      assert.equal(result.status, 0, result.stderr)
      return result.stdout.trim()
    }
    const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
    try {
      git(['init', '--initial-branch=main'])
      git(['config', 'diff.renames', scenario.renames === false ? 'false' : 'true'])
      for (const pkg of ['alpha', 'beta', 'gamma']) put(`packages/${pkg}/package.json`, JSON.stringify({ name: pkg, version: '1.0.0' }))
      for (const [file, text] of Object.entries(scenario.files ?? {})) put(file, text)
      git(['add', '.']); git(['commit', '-m', 'initial'])
      const commit = git(['rev-parse', 'HEAD'])
      for (const action of scenario.actions ?? []) {
        if (action.kind === 'move') { mkdirSync(dirname(join(root, action.to)), { recursive: true }); renameSync(join(root, action.from), join(root, action.to)) }
        else if (action.kind === 'write') put(action.path, action.text)
        else if (action.kind === 'append') appendFileSync(join(root, action.path), action.text)
        else if (action.kind === 'delete') unlinkSync(join(root, action.path))
        else throw new Error('Unknown scenario operation')
      }
      git(['add', '.'])
      if (scenario.actions?.length && scenario.committed !== false) git(['commit', '-m', 'change'])
      const diffStatus = git(['diff', '--name-status', commit, '--', root])
      const renameDetected = /^R\d+\s/mu.test(diffStatus)
      if (scenario.requireRename) assert(renameDetected, 'Git must actually detect a rename for this regression')
      const dirs = ['alpha', 'beta', 'gamma'].map(name => join(root, 'packages', name))
      const actual = await getChangedPackages(dirs, commit, { workspaceDir: root, testPattern: scenario.testPattern, changedFilesIgnorePattern: scenario.ignore })
      const normalized = actual.map(items => items.map(path => relative(root, path).replaceAll('\\', '/')).sort())
      const expected = [scenario.expectedSource, scenario.expectedTest ?? []].map(items => items.map(name => `packages/${name}`).sort())
      results.push({ id: scenario.id, passed: JSON.stringify(normalized) === JSON.stringify(expected), expected, actual: normalized, renameDetected, diffStatus, gitFixture: root })
    } catch (error) {
      results.push({ id: scenario.id, passed: false, error: { name: error.name, message: error.message }, gitFixture: root })
    }
  }
  return { passed: results.every(item => item.passed), cases: results.length, failed: results.filter(item => !item.passed).length, results }
}
