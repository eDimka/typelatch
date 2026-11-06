import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {adjudicate} from './review.mjs'
const hash=value=>createHash('sha256').update(value).digest('hex')
const sum=values=>values.reduce((a,b)=>a+b,0)
const median=values=>{const sorted=values.toSorted((a,b)=>a-b);return (sorted[(sorted.length-1)>>1]+sorted[sorted.length>>1])/2}
const reduction=(control,candidate)=>control>0?100*(control-candidate)/control:null
export const challengePolicy=Object.freeze({schemaVersion:1,candidate:'impact',challenger:'codegraph',category:'impact',minimumReductionPercent:20,minimumHeldoutTasks:2,repeats:2,controls:['native','competitor','codegraph'],rule:'Apply the original native and Serena gate unchanged. Also require at least 20 percent aggregate and median paired savings against CodeGraph in total tokens and provider setup plus agent time, with savings in both repetition aggregates. Require complete reviewed workflows and correct answers in all four conditions. Use the same frozen tasks, source, permissions, model and counterbalanced four condition schedule. Retain every failure. This establishes only an exploratory result on the named snapshots and tasks, never universal superiority.'})

export function compareCodegraph(report,reviewed){
 const reasons=[],protocol=report.protocol,policy=challengePolicy
 const base=reviewed.decision?.candidates?.impact?.categories?.impact
 if(reviewed.decision?.measurable!==true||base?.qualifiedEdge!==true)reasons.push('The original native and Serena gate did not qualify.')
 if(protocol.phase!=='confirmation'||protocol.repeats!==2||protocol.tasks.length<2||protocol.tasks.some(t=>t.category!=='impact'||t.split!=='heldout'))reasons.push('Two unseen impact tasks and two repetitions are required.')
 if(JSON.stringify(protocol.arms.toSorted())!==JSON.stringify(['native','impact','competitor','codegraph'].toSorted()))reasons.push('The prespecified four conditions are required.')
 if(report.runs.some(r=>r.correct!==true))reasons.push('All four conditions must return independently correct answers.')
 if(reviewed.review?.length!==report.runs.length||reviewed.review.some(r=>!r.workflowReviewed||(r.id.endsWith('-codegraph')&&!r.providerUsed)))reasons.push('Complete workflow review and relevant CodeGraph use are required.')
 const metrics={}
 for(const [name,read] of Object.entries({totalTokens:r=>r.usage.totalTokens,chargedTimeMs:r=>r.providerSetupMs+r.elapsedMs})){
  const pairs=protocol.tasks.flatMap(task=>[1,2].map(repeat=>{
   const a=report.runs.find(r=>r.task===task.id&&r.repeat===repeat&&r.arm==='codegraph'),b=report.runs.find(r=>r.task===task.id&&r.repeat===repeat&&r.arm==='impact')
   if(!a||!b)return null
   const control=read(a),candidate=read(b)
   if(!Number.isFinite(control)||!Number.isFinite(candidate)||control<=0||candidate<0)return null
   return {task:task.id,repeat,control,candidate,reductionPercent:reduction(control,candidate)}
  }))
  if(pairs.some(p=>!p)){reasons.push(`${name}: complete finite positive pairs are required.`);continue}
  const control=sum(pairs.map(p=>p.control)),candidate=sum(pairs.map(p=>p.candidate))
  const aggregateReductionPercent=reduction(control,candidate),medianPairedReductionPercent=median(pairs.map(p=>p.reductionPercent))
  const repeats=[1,2].map(repeat=>{const selected=pairs.filter(p=>p.repeat===repeat),a=sum(selected.map(p=>p.control)),b=sum(selected.map(p=>p.candidate));return {repeat,control:a,candidate:b,reductionPercent:reduction(a,b)}})
  metrics[name]={control,candidate,aggregateReductionPercent,medianPairedReductionPercent,repeats,pairs}
  if(aggregateReductionPercent<policy.minimumReductionPercent||medianPairedReductionPercent<policy.minimumReductionPercent)reasons.push(`${name}: aggregate or median savings below 20 percent.`)
  if(repeats.some(r=>r.reductionPercent<=0))reasons.push(`${name}: one repetition did not improve.`)
 }
 return {qualifiedAcrossMeasuredControls:reasons.length===0,reasons,metrics,scope:policy.rule}
}

export function adjudicateCodegraph(input){
 const reviewed=adjudicate(input),report=JSON.parse(input.reportBytes),protocol=report.protocol
 const policyBytes=JSON.stringify(challengePolicy,null,2)+'\n'
 assert(protocol.inputs.some(row=>row.kind==='file'&&row.path.endsWith('/codegraph-challenge-policy.json')&&row.sha256===hash(policyBytes)),'The challenge policy must be frozen before all sessions')
 return {schemaVersion:1,reportSha256:hash(input.reportBytes),protocolSha256:hash(input.protocolBytes),auditSha256:reviewed.auditSha256,policySha256:hash(policyBytes),...compareCodegraph(report,reviewed)}
}
