import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function initializeFixtureGit({ workspace, trackingManifest, state, gitBinary = '/usr/bin/git' }) {
  const paths = trackingManifest.entries.filter(entry => entry.kind !== 'directory').map(entry => entry.path).toSorted()
  assert(paths.length > 0 && new Set(paths).size === paths.length)
  for (const path of paths) {
    assert(path && !path.startsWith('/') && !path.includes('\0') && !path.split('/').some(part => ['..', '.', '.git'].includes(part)), 'Unsafe tracked source path')
    const entry = lstatSync(join(workspace, path)); assert(entry.isFile() || entry.isSymbolicLink(), 'Tracked sources must exist as files or links')
  }
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid', GIT_COMMITTER_NAME: 'Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
  const git = args => { const result = spawnSync(gitBinary, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', '-c', 'commit.gpgSign=false', '--literal-pathspecs', '-C', workspace, ...args], { env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim() }
  git(['init', '--quiet', '--initial-branch=benchmark'])
  const list = join(state, 'tracked-source-paths.nul')
  writeFileSync(list, Buffer.from(paths.join('\0') + '\0'), { mode: 0o600, flag: 'wx' })
  git(['add', '--force', '--pathspec-file-nul', '--pathspec-from-file=' + list])
  git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Isolated benchmark baseline'])
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), realpathSync(workspace), 'Fixture must own its nearest Git root')
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean).toSorted()
  assert.deepEqual(tracked, paths, 'Only the exact source inventory may be tracked')
  return { head: git(['rev-parse', 'HEAD']), trackedFiles: paths.length, root: workspace, gitBinary, policy: 'Independent initial commit, exact original source inventory, no upstream history. Installed dependencies stay untracked unless present in the committed source inventory.' }
}

export function verifyFixtureGit(workspace, before) {
  const result = spawnSync(before.gitBinary, ['-C', workspace, 'rev-parse', '--show-toplevel', 'HEAD'], { encoding: 'utf8', timeout: 10000 })
  return result.status === 0 && realpathSync(result.stdout.trim().split('\n')[0]) === realpathSync(workspace) && result.stdout.trim().split('\n')[1] === before.head
}
