import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {hash} from '../../../../scripts/paired-agent-runner.mjs'
import {validateSpec} from './run.mjs'
const [selectionArgument,outputArgument]=process.argv.slice(2)
assert(selectionArgument&&outputArgument,'Use SELECTION.json NEW_SPEC.json')
const selectionPath=resolve(selectionArgument),selection=JSON.parse(readFileSync(selectionPath)),read=path=>JSON.parse(readFileSync(path))
const providers=read(selection.providerSpec),qualification=read(selection.qualificationReceipt)
assert.equal(qualification.passed,true)
for(const row of qualification.implementationInputs??[])assert.equal(hash(readFileSync(row.path)),row.sha256,'Provider implementation changed since actual model transport qualification')
const descriptors=selection.descriptors.map(path=>({path,value:read(path)}))
const tasks=descriptors.map(({value:d})=>({id:d.id,category:d.category,split:d.split,mode:d.mode,description:d.description,scope:d.scope,policy:d.mode==='edit'?'Only existing production source may change. Keep tests, dependencies, manifests and configuration fixed. Generated compiler outputs may be rebuilt.':'The sole allowed new file is '+d.answerFile+'. Preserve all existing files.',evaluationNotes:d.policy,...(d.mode==='edit'?{validationCommand:d.validationCommand,publicCases:d.publicCases}:{answerFile:d.answerFile})}))
const fixtures=Object.fromEntries(descriptors.map(({value:d})=>[d.id,Object.fromEntries(['workspace','initialManifest','qualification','sourceTrackingManifest','graderModule'].map(key=>[key,key==='qualification'&&typeof d[key]==='object'?d[key].path:d[key]]))]))
const inputs=[selectionPath,...descriptors.flatMap(({path,value:d})=>[path,...(d.frozenInputs??[])]),...(selection.extraFrozenInputs??[]),...['assemble-study.mjs','freeze-study.mjs','publish-freeze.mjs','run.test.mjs','decision.test.mjs','review.test.mjs'].map(path=>join(import.meta.dirname,path))]
const extractor=resolve(import.meta.dirname,'../../../../scripts/monorepo-tool-outputs.mjs')
const spec={...providers,status:'selected-and-ready',phase:selection.phase,repeats:selection.phase==='confirmation'?2:1,timeoutMs:900000,tasks,fixtures,sharedFrozenInputs:[...new Set(inputs)].map(path=>({path,kind:'file'})),supplementalOutputs:{extractor,extractorSha256:hash(readFileSync(extractor)),fileName:'tool-outputs.json'},toolUseQualification:{receipt:selection.qualificationReceipt,sourceSpec:selection.providerSpec}}
validateSpec(spec)
for(const {path} of spec.sharedFrozenInputs)assert(existsSync(path),path)
const output=resolve(outputArgument);writeFileSync(output,JSON.stringify(spec,null,2)+'\n',{flag:'wx',mode:0o600})
console.log(JSON.stringify({output,sha256:hash(readFileSync(output)),phase:spec.phase,tasks:tasks.map(row=>row.id),arms:Object.keys(spec.arms)}))
