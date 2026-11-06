import { join } from 'node:path'
import { grade } from './grading-common.mjs'
import { migrationScope } from './development-scope.mjs'
export async function gradeWorkspace(workspace, initial) {
  const result = grade(workspace, initial, join(import.meta.dirname, 'development-001/source-tracking-manifest.json'), join(import.meta.dirname, 'development-check.mjs'), 7)
  if (result.passed !== true) return { ...result, scope: { passed: false, reason: 'Not inspected because independent grading failed' }, passed: false }
  const scope = migrationScope(workspace)
  return { ...result, scope, passed: result.passed && scope.passed }
}
