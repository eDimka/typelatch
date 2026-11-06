import { runCases } from '../../api-migration/case-engine.mjs'
const result = await runCases([
  { id: 'writable-directory', shouldAllowWrite: true },
  { id: 'writable-spaced-path', spaces: true, shouldAllowWrite: true },
  { id: 'writable-multiple-path-entries', multiple: true, shouldAllowWrite: true },
  { id: 'symlink-matches-real-path', symlink: true, shouldAllowWrite: true },
  { id: 'missing-directory-rejected', missingDirectory: true, shouldAllowWrite: true, expectedError: 'ERR_PNPM_PNPM_DIR_NOT_WRITABLE' },
  { id: 'readonly-directory-rejected', readOnly: true, shouldAllowWrite: true, expectedError: 'ERR_PNPM_PNPM_DIR_NOT_WRITABLE' },
  { id: 'missing-directory-without-write-check', missingDirectory: true, shouldAllowWrite: false },
  { id: 'directory-prefix-is-not-path-membership', outsidePath: true, shouldAllowWrite: true, expectedError: 'ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH' },
  { id: 'missing-path-setting', noPath: true, shouldAllowWrite: true, expectedError: 'ERR_PNPM_NO_PATH_ENV' },
  { id: 'empty-path-setting', emptyPath: true, shouldAllowWrite: true, expectedError: 'ERR_PNPM_NO_PATH_ENV' },
  { id: 'optional-write-check-omitted', shouldAllowWrite: undefined },
])
console.log(JSON.stringify(result))
process.exitCode = result.passed ? 0 : 1
