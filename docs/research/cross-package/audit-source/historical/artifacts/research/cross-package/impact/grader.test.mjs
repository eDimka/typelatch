import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { gradeAnswer, gradeFixture } from './grade-answer.mjs'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
const base=resolve('artifacts/research/cross-package/impact')
const load=(id,suffix)=>JSON.parse(readFileSync(`${base}/private/${id}-${suffix}.json`))
for(const id of ['development','heldout']) {
 const truth=load(id,'oracle'),gold=load(id,'gold'),workspace=truth.workspace
 test(`${id}: independently derived complete evidence passes`,()=>{assert.equal(gradeAnswer(workspace,gold,truth).passed,true)})
 for(const [name,change] of Object.entries({
  'omitted direct consumer':a=>a.direct.pop(),
  'wrong runtime versus type classification':a=>{a.direct[0].role=a.direct[0].role==='runtime'?'type-only':'runtime'},
  'missing transitive dependent':a=>a.packageDependents.pop(),
  'invented dependency chain':a=>{a.packageDependents[0].chain=[a.packageDependents[0].package,'not-a-workspace-package',a.target.package]},
  'wrong package version':a=>{a.target.version='0.0.0'},
  'invented source quote':a=>{a.direct[0].evidence.quote='THIS IS NOT THE SOURCE'},
  'missing native validation target':a=>a.validationTargets.pop(),
  'confident false negative':a=>{a.negativeClaims.push({file:a.direct[0].file,symbol:a.direct[0].symbol})},
  'unacknowledged external unknowns':a=>{a.uncertainties=[]},
  'duplicate inflated evidence':a=>a.direct.push(a.direct[0]),
 }))test(`${id}: rejects ${name}`,()=>{const answer=structuredClone(gold);change(answer);assert.equal(gradeAnswer(workspace,answer,truth).passed,false)})
}
test('a range containing a consumer cannot launder an unrelated quote',()=>{
 const truth=load('development','oracle'),answer=load('development','gold'),workspace=truth.workspace
 const row=answer.direct.find(row=>row.evidence.startLine>2),line=row.evidence.startLine,lines=readFileSync(join(workspace,row.file),'utf8').split('\n')
 const unrelated=lines.slice(Math.max(0,line-20),line-1).find(text=>text.trim().length>=3&&!text.includes(row.symbol))
 assert(unrelated)
 row.evidence={startLine:Math.max(1,line-19),endLine:line,quote:unrelated}
 assert.equal(gradeAnswer(workspace,answer,truth).passed,false)
})
test('an answer symlink outside the workspace is rejected',()=>{
 const temp=mkdtempSync(join(tmpdir(),'typelatch-impact-answer-')),workspace=join(temp,'workspace');mkdirSync(workspace)
 const truth={target:{package:'test',version:'1',exports:[]},direct:[],packageDependents:[],packageGraph:[],validationTargets:[],exclusions:[],requiredUncertainties:[]}
 const answer={schemaVersion:1,target:truth.target,direct:[],packageDependents:[],validationTargets:[],exclusions:[],uncertainties:[],negativeClaims:[]}
 try{const initial=inventoryTree(workspace);writeFileSync(join(temp,'answer.json'),JSON.stringify(answer));symlinkSync('../answer.json',join(workspace,'impact-answer.json'));assert.equal(gradeFixture(workspace,initial,truth).passed,false)}finally{rmSync(temp,{recursive:true,force:true})}
})
