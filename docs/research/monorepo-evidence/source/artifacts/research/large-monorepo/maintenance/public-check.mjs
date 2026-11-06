import { runCases } from './case-engine.mjs'
const content = 'export const value = 1;\n'
const result = await runCases([
  { id: 'move-between-projects', files: { 'packages/alpha/src/value.ts': content }, actions: [{ kind: 'move', from: 'packages/alpha/src/value.ts', to: 'packages/beta/src/value.ts' }], requireRename: true, expectedSource: ['alpha', 'beta'] },
  { id: 'ordinary-edit', files: { 'packages/alpha/src/value.ts': content }, actions: [{ kind: 'append', path: 'packages/alpha/src/value.ts', text: '// edit\n' }], expectedSource: ['alpha'] },
  { id: 'unchanged', files: { 'packages/alpha/src/value.ts': content }, actions: [], expectedSource: [] },
])
console.log(JSON.stringify(result))
process.exitCode = result.passed ? 0 : 1
