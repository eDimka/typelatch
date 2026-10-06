import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const defaultBaselineRef = '0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125'

/** Compile an immutable baseline with the current installed toolchain and dependencies. */
export function prepareBaseline(directory, requestedRef = defaultBaselineRef) {
  const ref = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${requestedRef}^{commit}`], { encoding: 'utf8' }).trim()
  const readFile = path => execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const readTree = paths => execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...paths], { encoding: 'utf8' })
    .split('\0').filter(Boolean).map(path => ({ path, text: readFile(path) }))
  const sourceDirectory = resolve(directory, 'baseline-source')
  const distDirectory = resolve(directory, 'baseline-dist')
  rmSync(sourceDirectory, { recursive: true, force: true })
  rmSync(distDirectory, { recursive: true, force: true })
  const files = [...readTree(['src']), ...['tsconfig.json', 'package.json'].map(path => ({ path, text: readFile(path) }))]
  for (const file of files) {
    const path = join(sourceDirectory, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.text)
  }
  execFileSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(sourceDirectory, 'tsconfig.json'), '--outDir', distDirectory], { stdio: 'inherit' })
  return { ref, sourceDirectory, distDirectory, readFile, readTree }
}
