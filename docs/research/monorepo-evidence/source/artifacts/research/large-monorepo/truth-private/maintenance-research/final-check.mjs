import { runCases } from '../../maintenance/case-engine.mjs'
const content = 'export const original = 20;\nexport const second = 30;\n'
const move = (id, from, to, options = {}) => ({ id, files: { [from]: content }, actions: [{ kind: 'move', from, to }], requireRename: true, expectedSource: ['alpha', 'beta'], ...options })
const result = await runCases([
  move('cross-project-forward', 'packages/alpha/src/a.ts', 'packages/beta/src/a.ts'),
  move('cross-project-reverse', 'packages/beta/src/a.ts', 'packages/alpha/src/a.ts'),
  move('cross-project-new-filename', 'packages/alpha/src/a.ts', 'packages/beta/src/renamed.ts'),
  move('staged-uncommitted', 'packages/alpha/src/a.ts', 'packages/beta/src/a.ts', { committed: false }),
  move('nested-and-spaced-path', 'packages/alpha/src/deeper/file name.ts', 'packages/beta/lib/inner/file name.ts'),
  move('same-project', 'packages/alpha/src/a.ts', 'packages/alpha/src/renamed.ts', { expectedSource: ['alpha'] }),
  move('test-only-move', 'packages/alpha/test/a.ts', 'packages/beta/test/a.ts', { testPattern: ['**/test/**'], expectedSource: [], expectedTest: ['alpha', 'beta'] }),
  move('source-to-test', 'packages/alpha/src/a.ts', 'packages/beta/test/a.ts', { testPattern: ['**/test/**'], expectedSource: ['alpha'], expectedTest: ['beta'] }),
  move('fully-ignored', 'packages/alpha/ignored/a.ts', 'packages/beta/ignored/a.ts', { ignore: ['**/ignored/**'], expectedSource: [] }),
  move('ignored-origin', 'packages/alpha/src/a.ts', 'packages/beta/src/a.ts', { ignore: ['packages/alpha/**'], expectedSource: ['beta'] }),
  move('rename-disabled-control', 'packages/alpha/src/a.ts', 'packages/beta/src/a.ts', { renames: false, requireRename: false }),
  { id: 'ordinary-edit', files: { 'packages/gamma/src/a.ts': content }, actions: [{ kind: 'append', path: 'packages/gamma/src/a.ts', text: '// edit\n' }], expectedSource: ['gamma'] },
  { id: 'ordinary-deletion', files: { 'packages/alpha/src/a.ts': content }, actions: [{ kind: 'delete', path: 'packages/alpha/src/a.ts' }], expectedSource: ['alpha'] },
  { id: 'ordinary-addition', files: {}, actions: [{ kind: 'write', path: 'packages/beta/src/a.ts', text: content }], expectedSource: ['beta'] },
  { id: 'unchanged', files: { 'packages/gamma/src/a.ts': content }, actions: [], expectedSource: [] },
])
console.log(JSON.stringify(result))
process.exitCode = result.passed ? 0 : 1
