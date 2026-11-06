import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {resolve,join} from 'node:path'
import {hash} from '../../../../scripts/paired-agent-runner.mjs'
const [specArgument,studyArgument]=process.argv.slice(2)
assert(specArgument&&studyArgument,'Use SPEC.json NEW_STUDY_DIRECTORY')
const specPath=resolve(specArgument),spec=JSON.parse(readFileSync(specPath)),proof=JSON.parse(readFileSync(spec.toolUseQualification.receipt))
assert.equal(proof.passed,true)
for(const row of proof.implementationInputs??[])assert.equal(hash(readFileSync(row.path)),row.sha256,'Implementation no longer matches actual model transport qualification')
const result=spawnSync(process.execPath,[join(import.meta.dirname,'run-v2.mjs'),'--freeze',specPath,resolve(studyArgument)],{stdio:'inherit'})
assert.equal(result.status,0,'Study preparation failed')
const protocol=JSON.parse(readFileSync(join(resolve(studyArgument),'protocol.json')))
for(const row of proof.implementationInputs??[]){assert.equal(hash(readFileSync(row.path)),row.sha256);assert(protocol.inputs.some(input=>input.path===row.path&&input.kind==='file'&&input.sha256===row.sha256),'Implementation proof missing from frozen inputs')}
