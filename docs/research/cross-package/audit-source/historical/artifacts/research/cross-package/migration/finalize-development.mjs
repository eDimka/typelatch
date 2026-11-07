import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import { integrity, sha } from './grading-common.mjs'
const here = import.meta.dirname, output = join(here, 'development-001'), workspace = join(output, 'workspace')
const read = file => JSON.parse(readFileSync(file)), write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const receiptPath = join(output, 'finalization.json'); assert(!existsSync(receiptPath))
const initialPath = join(output, 'initial-manifest.json'), previous = read(initialPath), actual = inventoryTree(workspace), tracking = read(join(output, 'source-tracking-manifest.json'))
const comparison = integrity(previous, actual, tracking); assert.equal(comparison.passed, true); assert.deepEqual(comparison.changed, [])
cpSync(initialPath, join(output, 'qualification-initial-manifest.json')); write(initialPath, actual)
const binary = path => ({ path: realpathSync(path), sha256: sha(readFileSync(realpathSync(path))) })
const toolchain = { node: { ...binary(process.execPath), version: process.version }, compiler: { ...binary(join(workspace, 'node_modules/typescript/bin/tsc')), version: read(join(workspace, 'node_modules/typescript/package.json')).version, packageTreeSha256: inventoryTree(realpathSync(join(workspace, 'node_modules/typescript'))).sha256 }, git: { ...binary('/usr/bin/git'), version: spawnSync('/usr/bin/git', ['--version'], { encoding: 'utf8' }).stdout.trim() }, tar: { ...binary('/usr/bin/tar'), version: spawnSync('/usr/bin/tar', ['--version'], { encoding: 'utf8' }).stdout.trim() }, loader: 'No external TypeScript loader. Original TypeScript project builds emit CommonJS consumed by native Node.' }
write(receiptPath, { status: 'finalized', qualificationSha256: sha(readFileSync(join(output, 'qualification.json'))), qualificationInitialSha256: previous.sha256, finalInitialSha256: actual.sha256, comparison, toolchain, note: 'Qualification restores baseline source after each mutation. Only disposable generated compiler files differ from the pre-qualification inventory; final initial manifest now records those exact retained baseline bytes.' })
const descriptorFile = join(output, 'descriptor.json'), descriptor = read(descriptorFile)
descriptor.finalization = { path: receiptPath, sha256: sha(readFileSync(receiptPath)) }; descriptor.toolchain = toolchain
write(descriptorFile, descriptor)
console.log(JSON.stringify({ status: 'finalized', descriptor: descriptorFile, sourceChanges: comparison.changed, generatedChanges: comparison.generatedChanged.length, treeSha256: actual.sha256 }))
