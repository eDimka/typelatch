import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runCases(cases) {
  const implementation = await import(pathToFileURL(join(resolve(process.cwd()), 'config/config/src/checkGlobalBinDir.ts')).href)
  const check = implementation.checkGlobalBinDir ?? implementation.default?.checkGlobalBinDir
  assert.equal(typeof check, 'function')
  const results = [], unexpectedRejections = []
  const rejection = error => unexpectedRejections.push({ name: error?.name, message: error?.message })
  process.on('unhandledRejection', rejection)
  try {
    for (const scenario of cases) {
      const root = mkdtempSync(join(tmpdir(), 'typelatch-bin-migration-'))
      const directory = join(root, scenario.spaces ? 'global bin with spaces' : 'bin'), other = join(root, 'bin-other')
      mkdirSync(other)
      if (!scenario.missingDirectory) mkdirSync(directory)
      let selected = directory
      if (scenario.symlink) { selected = join(root, 'linked-bin'); symlinkSync(directory, selected, 'dir') }
      if (scenario.readOnly) { assert.notEqual(process.getuid?.(), 0, 'Permission case requires the ordinary benchmark user'); chmodSync(directory, 0o555) }
      const env = scenario.noPath ? {} : { PATH: scenario.emptyPath ? '' : scenario.outsidePath ? other : scenario.multiple ? `${other}${delimiter}${directory}${delimiter}${root}` : directory }
      if (scenario.symlink) env.PATH = realpathSync(directory)
      let actual
      const rejectionCount = unexpectedRejections.length
      try { await check(selected, { env, shouldAllowWrite: scenario.shouldAllowWrite }); actual = { ok: true } }
      catch (error) { actual = { ok: false, name: error.name, code: error.code ?? null, message: error.message } }
      await new Promise(done => setImmediate(done))
      const unhandled = unexpectedRejections.slice(rejectionCount)
      const passed = unhandled.length === 0 && (scenario.expectedError ? actual.ok === false && actual.code === scenario.expectedError : actual.ok === true)
      results.push({ id: scenario.id, passed, expectedError: scenario.expectedError ?? null, actual, unhandled, temporaryDirectory: root })
      if (scenario.readOnly) chmodSync(directory, 0o755)
    }
  } finally { process.removeListener('unhandledRejection', rejection) }
  return { passed: results.every(item => item.passed), cases: results.length, failed: results.filter(item => !item.passed).length, results }
}
