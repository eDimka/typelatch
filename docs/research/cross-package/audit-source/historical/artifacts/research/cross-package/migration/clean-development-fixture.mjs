import assert from 'node:assert/strict'
import { constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import { targets, sources } from './prepare-development.mjs'
import { sha, sourceManifest, integrity } from './grading-common.mjs'
import { gradeWorkspace } from './development-grade.mjs'

const here = import.meta.dirname, output = join(here, 'development-001'), workspace = join(output, 'workspace')
const read = file => JSON.parse(readFileSync(file)), write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const receiptPath = join(output, 'generated-output-cleanup-001.json'), archive = join(output, 'retained-generated-001'), archiveTree = join(archive, 'tree'), descriptorPath = join(output, 'descriptor.json')
assert(!existsSync(receiptPath) && !existsSync(archive), 'Preserve every cleanup attempt')
const descriptor = read(descriptorPath), originalDescriptorBytes = readFileSync(descriptorPath)
const selected = targets.flatMap(target => [target + '/lib', target + '/tsconfig.tsbuildinfo'])
const receipt = { schemaVersion: 1, status: 'preparing', startedAt: new Date().toISOString(), previousDescriptorSha256: sha(originalDescriptorBytes), selected, results: {} }
const persist = () => write(receiptPath, receipt); persist()
try {
  const before = inventoryTree(workspace), initial = read(descriptor.initialManifest), tracking = read(descriptor.sourceTrackingManifest)
  assert.equal(before.sha256, initial.sha256, 'Fixture must exactly match its existing initial inventory')
  for (const entry of tracking.entries) assert(!selected.some(path => entry.path === path || entry.path.startsWith(path + '/')), `Cannot remove tracked source: ${entry.path}`)
  const selectedEntry = path => selected.some(prefix => path === prefix || path.startsWith(prefix + '/'))
  const previousSelected = before.entries.filter(entry => selectedEntry(entry.path))
  mkdirSync(archiveTree, { recursive: true }); writeFileSync(join(archive, 'descriptor-before.json'), originalDescriptorBytes)
  receipt.before = { manifest: descriptor.initialManifest, treeSha256: before.sha256, sourceTrackingSha256: tracking.sha256 }
  receipt.removedEntries = previousSelected; persist()
  for (const path of selected) {
    assert(existsSync(join(workspace, path)), `Expected generated output is absent: ${path}`)
    mkdirSync(dirname(join(archiveTree, path)), { recursive: true })
    renameSync(join(workspace, path), join(archiveTree, path))
  }
  const archived = inventoryTree(archiveTree)
  const archivedEntries = archived.entries.filter(entry => selectedEntry(entry.path))
  assert.deepEqual(archivedEntries, previousSelected, 'Retained archive must preserve every byte, mode and link')
  write(join(archive, 'manifest.json'), archived)
  const tarball = join(archive, 'generated-outputs.tar')
  const tar = spawnSync('/usr/bin/tar', ['-cf', tarball, '-C', archiveTree, '.'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, tar.stderr)
  receipt.archive = { path: archiveTree, treeSha256: archived.sha256, manifest: join(archive, 'manifest.json'), tarball, tarballSha256: sha(readFileSync(tarball)), tarballBytes: statSync(tarball).size }
  const after = inventoryTree(workspace), comparison = integrity(before, after, tracking)
  assert.equal(comparison.passed, true); assert.deepEqual(comparison.changed, [])
  assert.deepEqual(comparison.generatedChanged.toSorted(), previousSelected.filter(entry => entry.kind !== 'directory').map(entry => entry.path).toSorted())
  assert.deepEqual(sourceManifest(workspace).entries, tracking.entries, 'Tracked unfinished source must remain byte-identical')
  for (const path of selected) assert(!existsSync(join(workspace, path)), `Completed output remains: ${path}`)
  const cleanManifest = join(output, 'initial-clean-manifest.json'); write(cleanManifest, after)
  receipt.cleaned = { initialManifest: cleanManifest, treeSha256: after.sha256, sourceTrackingSha256: tracking.sha256, comparison, noTargetOutputsRemain: true }
  persist()
  const checkRoot = join(output, 'cleanup-qualification-001'); mkdirSync(checkRoot)
  for (const variant of ['baseline', 'reference']) {
    const copy = join(checkRoot, variant), start = performance.now()
    cpSync(workspace, copy, { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE_FORCE })
    const copied = inventoryTree(copy)
    assert.equal(copied.sha256, after.sha256, 'Independent qualification clone must start with exact cleaned bytes')
    const fixtureFile = join(workspace, sources[0]), copiedFile = join(copy, sources[0])
    assert.notEqual(statSync(fixtureFile).ino, statSync(copiedFile).ino, 'Qualification must not share writable hardlinks')
    const preparationMs = performance.now() - start
    if (variant === 'reference') for (const [index, source] of sources.entries()) writeFileSync(join(copy, source), readFileSync(join(output, 'reference-sources', `${index}.ts`)))
    const result = await gradeWorkspace(copy, after)
    receipt.results[variant] = { workspace: copy, preparationMs, result }; persist()
    if (variant === 'baseline') { assert.equal(result.passed, false); assert.equal(result.checks.result.results[0].passed, false); assert.equal(result.scope.reason, 'Not inspected because independent grading failed') }
    else { assert.equal(result.passed, true); assert.equal(result.checks.result.cases, 7); assert.equal(result.scope.passed, true) }
    assert.equal(inventoryTree(workspace).sha256, after.sha256, 'Copy qualification must not contaminate the original cleaned fixture')
  }
  for (const path of selected) assert(!existsSync(join(workspace, path)))
  receipt.status = 'qualified'; receipt.completedAt = new Date().toISOString()
  receipt.policy = 'Only the five generated target lib trees and their five build-info files are removed from the initial fixture. Exact outputs are retained externally with tree and tarball hashes. All tracked source, dependencies, configuration and unrelated prerequisite build outputs remain unchanged. Baseline and reference are requalified on distinct-inode APFS clones; the cleaned initial fixture is never built.'
  receipt.inputs = [...new Set([...descriptor.frozenInputs, join(here, 'clean-development-fixture.mjs')])].map(path => ({ path, sha256: sha(readFileSync(path)) }))
  persist()
  descriptor.initialManifest = cleanManifest
  descriptor.finalizationHistory = [...(descriptor.finalizationHistory ?? [descriptor.finalization]), { path: receiptPath, sha256: sha(readFileSync(receiptPath)) }]
  descriptor.finalization = descriptor.finalizationHistory.at(-1)
  descriptor.fixtureCleanup = descriptor.finalization
  descriptor.frozenInputs = [...new Set([...descriptor.frozenInputs, join(here, 'clean-development-fixture.mjs'), receiptPath, cleanManifest, join(output, 'compiled-output-audit-before.json'), join(archive, 'manifest.json')])]
  descriptor.policy.push('Initial fixture contains no generated target JavaScript, declarations, source maps or build-info files. Baseline and reference qualification run only on isolated copies; all removed outputs are retained outside the fixture.')
  write(descriptorPath, descriptor)
  console.log(JSON.stringify({ status: receipt.status, descriptor: descriptorPath, descriptorSha256: sha(readFileSync(descriptorPath)), cleanTreeSha256: after.sha256, removedFiles: comparison.generatedChanged.length, frozenInputs: descriptor.frozenInputs.length, baselinePassed: receipt.results.baseline.result.passed, referencePassed: receipt.results.reference.result.passed }))
} catch (error) { receipt.status = 'cleanup-or-qualification-failed'; receipt.error = error.message; persist(); throw error }
