import { resolve } from 'node:path'
import { runSupport } from '../dist/support.js'
import { summarizeSupport } from './supportsummary.mjs'

process.env.APIROVA_HOME ??= resolve('.apirova')
process.env.APIROVA_USAGE = 'off'
const report = await runSupport('examples/support/manifest.json', '.apirova/evidence/support.json', console.error)
summarizeSupport('.apirova/evidence/support.json')
console.log(JSON.stringify({ passed: report.passed, totals: report.totals }, null, 2))
if (!report.passed) process.exitCode = 1
