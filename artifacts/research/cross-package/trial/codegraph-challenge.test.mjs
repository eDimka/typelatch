import assert from 'node:assert/strict'
import test from 'node:test'
import {compareCodegraph} from './codegraph-challenge.mjs'
function sample(){
 const protocol={phase:'confirmation',repeats:2,arms:['native','impact','competitor','codegraph'],tasks:[{id:'one',category:'impact',split:'heldout',mode:'analysis'},{id:'two',category:'impact',split:'heldout',mode:'analysis'}]}
 const runs=protocol.tasks.flatMap(task=>[1,2].flatMap(repeat=>protocol.arms.map(arm=>({id:`${task.id}-r${repeat}-${arm}`,task:task.id,repeat,arm,correct:true,usage:{totalTokens:arm==='impact'?600:1000},providerSetupMs:arm==='codegraph'?100:0,elapsedMs:arm==='impact'?600:900}))))
 const report={protocol,runs},reviewed={decision:{measurable:true,candidates:{impact:{categories:{impact:{qualifiedEdge:true}}}}},review:runs.map(r=>({id:r.id,workflowReviewed:true,providerUsed:r.arm!=='native'}))}
 return {report,reviewed}
}
test('additional challenge requires both metrics and charges provider setup',()=>{
 const {report,reviewed}=sample();const result=compareCodegraph(report,reviewed);assert.equal(result.qualifiedAcrossMeasuredControls,true);assert.equal(result.metrics.chargedTimeMs.control,4000)
 for(const row of report.runs.filter(r=>r.arm==='impact'))row.providerSetupMs=300
 assert.equal(compareCodegraph(report,reviewed).qualifiedAcrossMeasuredControls,false)
})
test('one losing repetition, median failure and token regression each block promotion',()=>{
 for(const change of [
  report=>{for(const row of report.runs.filter(r=>r.arm==='impact'&&r.repeat===2))row.elapsedMs=1100},
  report=>{const selected=report.runs.filter(r=>r.arm==='impact');selected.forEach((r,i)=>{r.usage.totalTokens=i===0?0:900})},
  report=>{for(const row of report.runs.filter(r=>r.arm==='impact'))row.usage.totalTokens=1200},
 ]){const {report,reviewed}=sample();change(report);assert.equal(compareCodegraph(report,reviewed).qualifiedAcrossMeasuredControls,false)}
})
test('correctness, workflow, control use and original gate remain mandatory',()=>{
 for(const change of [
  ({report})=>{report.runs.find(r=>r.arm==='codegraph').correct=false},
  ({reviewed})=>{reviewed.review[0].workflowReviewed=false},
  ({reviewed})=>{reviewed.review.find(r=>r.id.endsWith('-codegraph')).providerUsed=false},
  ({reviewed})=>{reviewed.decision.candidates.impact.categories.impact.qualifiedEdge=false},
  ({report})=>{report.protocol.phase='development'},
  ({report})=>{report.runs=report.runs.filter(r=>r.id!=='one-r1-codegraph')},
 ]){const input=sample();change(input);assert.equal(compareCodegraph(input.report,input.reviewed).qualifiedAcrossMeasuredControls,false)}
})

import {createHash} from 'node:crypto'
import {adjudicateCodegraph,challengePolicy} from './codegraph-challenge.mjs'
import {makeSchedule,decisionGate} from './decision.mjs'
import {reviewRules} from './review.mjs'
const hash=x=>createHash('sha256').update(x).digest('hex'),encode=x=>JSON.stringify(x,null,2)+'\n'
function boundFixture({policyHash=hash(encode(challengePolicy))}={}){
 const {report:base}=sample(),protocol={...base.protocol,candidates:['impact','codegraph'],decisionGate,inputs:[{kind:'file',path:'/fixture/codegraph-challenge-policy.json',sha256:policyHash}],spec:{arms:Object.fromEntries(base.protocol.arms.map(arm=>[arm,{servers:arm==='native'?{}:{[arm]:{}}}]))}}
 protocol.schedule=makeSchedule(protocol.tasks,protocol.arms,protocol.repeats)
 protocol.prompts=protocol.tasks.flatMap(task=>protocol.arms.map(arm=>({task:task.id,arm,prompt:`Task ${task.id} ${arm}`,promptSha256:hash(`Task ${task.id} ${arm}`)})))
 const protocolBytes=encode(protocol),records=new Map(),outputs=new Map(),review=[]
 const runs=protocol.schedule.map(slot=>{
  const prompt=protocol.prompts.find(p=>p.task===slot.task&&p.arm===slot.arm),idSha256=hash(slot.id)
  const run={...base.runs.find(r=>r.id===slot.id),status:'completed',exitCode:0,timedOut:false,processGroupStopped:true,providerStopped:true,capture:{complete:true},usage:{inputTokens:slot.arm==='impact'?500:900,outputTokens:100,totalTokens:slot.arm==='impact'?600:1000},rawSha256:hash('raw'+slot.id),promptSha256:prompt.promptSha256}
  const action={idSha256,status:'completed',...(slot.arm==='native'?{type:'command_execution'}:{type:'mcp_tool_call',server:slot.arm,tool:'retrieve_source'})}
  const recordBytes=encode({run:structuredClone(run),prompt:prompt.prompt,actions:[action],grading:{passed:true}});run.evidenceSha256=hash(recordBytes);records.set(run.id,recordBytes)
  const outputBytes=encode({runId:run.id,publicRecordSha256:run.evidenceSha256,rawCaptureSha256:run.rawSha256,actions:[{...action,result:{text:'Synthetic recorded source'},error:null}]});run.toolOutputsSha256=hash(outputBytes);outputs.set(run.id,outputBytes)
  review.push({id:run.id,evidenceSha256:run.evidenceSha256,toolOutputsSha256:run.toolOutputsSha256,workflow:'pass',providerEvidence:slot.arm==='native'?'not-applicable':'usable',basisActionIds:[idSha256],providerActionIds:slot.arm==='native'?[]:[idSha256],notes:'Synthetic contract test only, not a real semantic audit.'});return run
 })
 const report={protocol,protocolSha256:hash(protocolBytes),complete:true,runs,preparationAttempts:runs.map(r=>({id:r.id,status:'ready'}))},reportBytes=encode(report)
 return {reportBytes,protocolBytes,records,outputs,audit:{schemaVersion:1,reportSha256:hash(reportBytes),protocolSha256:report.protocolSha256,rules:reviewRules,reviewer:'synthetic independent reviewer',noPrivateReasoningOrMessages:true,runs:review}}
}
test('wrapper requires the exact policy frozen with independently bound original evidence',()=>{
 assert.equal(adjudicateCodegraph(boundFixture()).qualifiedAcrossMeasuredControls,true)
 assert.throws(()=>adjudicateCodegraph(boundFixture({policyHash:hash('changed policy')})),/policy must be frozen/u)
 const input=boundFixture(),report=JSON.parse(input.reportBytes);report.runs[0].elapsedMs=1;input.reportBytes=encode(report);input.audit.reportSha256=hash(input.reportBytes)
 assert.throws(()=>adjudicateCodegraph(input),/Report\/public record disagreement/u)
})
