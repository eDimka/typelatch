import { resolve } from 'node:path'
import { runSupport } from '../dist/support.js'
import { summarizeSupport } from './supportsummary.mjs'

process.env.TYPELATCH_HOME ??= resolve('.typelatch')
process.env.TYPELATCH_USAGE = 'off'
const report = await runSupport('examples/support/manifest.json', '.typelatch/evidence/support.json', console.error)
summarizeSupport('.typelatch/evidence/support.json')
console.log(JSON.stringify({ passed: report.passed, totals: report.totals }, null, 2))
if (!report.passed) process.exitCode = 1
