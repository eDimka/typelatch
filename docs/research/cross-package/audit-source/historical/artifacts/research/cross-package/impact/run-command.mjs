import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const [receipt, cwd, command, ...args] = process.argv.slice(2)
if (!receipt || !cwd || !command) throw new Error('receipt cwd command args required')
const startedAt = new Date().toISOString(), started = performance.now()
const result = spawnSync(command, args, {
  cwd: resolve(cwd), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, CI: 'true', PUPPETEER_SKIP_DOWNLOAD: 'true', HUSKY: '0' },
})
const record = { startedAt, elapsedMs: performance.now() - started, cwd: resolve(cwd), command, args,
  environmentOverrides: { CI: 'true', PUPPETEER_SKIP_DOWNLOAD: 'true', HUSKY: '0' },
  exitCode: result.status, signal: result.signal, error: result.error?.message ?? null,
  stdout: result.stdout, stderr: result.stderr }
mkdirSync(dirname(resolve(receipt)), { recursive: true })
writeFileSync(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ receipt, elapsedMs: record.elapsedMs, exitCode: result.status, error: record.error }))
process.exitCode = result.status ?? 1
