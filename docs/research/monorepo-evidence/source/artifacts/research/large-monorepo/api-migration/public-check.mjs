import { runCases } from './case-engine.mjs'
const result = await runCases([
  { id: 'writable-global-directory', shouldAllowWrite: true },
  { id: 'write-check-disabled', shouldAllowWrite: false },
  { id: 'missing-path-setting', noPath: true, shouldAllowWrite: true, expectedError: 'ERR_PNPM_NO_PATH_ENV' },
])
console.log(JSON.stringify(result))
process.exitCode = result.passed ? 0 : 1
