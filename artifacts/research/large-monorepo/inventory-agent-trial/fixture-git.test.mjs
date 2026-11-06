import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeFixtureGit, verifyFixtureGit } from './fixture-git.mjs'

test('own Git boundary escapes ignored parent and preserves committed ignored paths', () => {
  const parent = mkdtempSync(join(tmpdir(), 'typelatch-git-boundary-'))
  assert.equal(spawnSync('/usr/bin/git', ['init', '-q', parent]).status, 0)
  writeFileSync(join(parent, '.gitignore'), 'artifacts/\n')
  const workspace = join(parent, 'artifacts/corpus'), state = join(parent, 'state')
  mkdirSync(join(workspace, 'node_modules'), { recursive: true }); mkdirSync(state)
  writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(workspace, 'source.ts'), 'export const value = 1\n')
  writeFileSync(join(workspace, 'node_modules/installed.js'), 'untracked installed dependency\n')
  symlinkSync('../source.ts', join(workspace, 'node_modules/committed-link'))
  assert.equal(spawnSync('/usr/bin/git', ['-C', workspace, 'check-ignore', 'source.ts']).status, 0, 'Initial fixture really inherits the parent ignore')
  const record = initializeFixtureGit({ workspace, state, trackingManifest: { entries: [{ path: '.gitignore', kind: 'file' }, { path: 'source.ts', kind: 'file' }, { path: 'node_modules/committed-link', kind: 'symlink' }] } })
  assert.equal(spawnSync('/usr/bin/git', ['-C', workspace, 'check-ignore', 'source.ts']).status, 1)
  assert.equal(verifyFixtureGit(workspace, record), true)
  assert.equal(record.trackedFiles, 3)
  assert.equal(spawnSync('/usr/bin/git', ['-C', workspace, 'ls-files', '--error-unmatch', 'node_modules/installed.js'], { stdio: 'ignore' }).status, 1)
})
