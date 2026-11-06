import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { hash } from '../../../../scripts/paired-agent-runner.mjs'
import { normalizeDemo } from '../../../../scripts/demo-evidence.mjs'
const [sourceArgument,destinationArgument]=process.argv.slice(2)
assert(sourceArgument&&destinationArgument,'Use PROTOCOL.json NEW_PUBLIC_DIRECTORY')
const source=resolve(sourceArgument),destination=resolve(destinationArgument),repository=resolve(import.meta.dirname,'../../../..')
const raw=readFileSync(source),protocol=JSON.parse(raw)
assert.equal(protocol.status,'frozen-before-agent-sessions')
assert(!existsSync(destination),'Never overwrite a public freeze')
const replacements=[[repository,'$REPOSITORY'],[homedir(),'$USER_HOME'],[tmpdir().replace(/\/$/u,''),'$TEMP']]
const bytes=JSON.stringify(normalizeDemo(protocol,replacements),null,2)+'\n'
assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(bytes))
mkdirSync(destination,{recursive:true})
writeFileSync(join(destination,'protocol.json'),bytes,{flag:'wx'})
const manifest={schemaVersion:1,status:'frozen-before-agent-sessions',createdAt:new Date().toISOString(),privateProtocolSha256:hash(raw),publicProtocolSha256:hash(bytes),normalization:'Absolute repository, home and temporary paths replaced by named placeholders. Private original remains immutable; content hashes bind original bytes. No agent outcomes exist at this publication step.',taskIds:protocol.tasks.map(t=>t.id),runCount:protocol.runCount}
writeFileSync(join(destination,'freeze.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(manifest))
