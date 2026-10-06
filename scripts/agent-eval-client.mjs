import { readFileSync } from 'node:fs'
const [controlPath, session, action, argument, editFile] = process.argv.slice(2)
if (!controlPath || !session || !action) throw new Error('Usage: agent-eval-client <control.json> <provider> query|list|read|edit|test [question|relative-path] [file-with-replacement-text]')
const control = JSON.parse(readFileSync(controlPath, 'utf8'))
const input = { session, action, ...(action === 'query' ? { question: argument } : {}), ...(['read', 'edit'].includes(action) ? { path: argument } : {}), ...(action === 'edit' ? { text: readFileSync(editFile, 'utf8') } : {}) }
const response = await fetch(control.url, { method: 'POST', headers: { Authorization: `Bearer ${control.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
const output = await response.json()
console.log(JSON.stringify(output, null, 2))
if (!response.ok) process.exitCode = 1
