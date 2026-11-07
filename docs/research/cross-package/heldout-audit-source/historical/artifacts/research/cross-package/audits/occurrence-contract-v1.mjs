import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gradeAnswer, evidenceValid } from '../impact/grading-v2/grade-answer.mjs'

const key=row=>`${row.file}|${row.symbol}|${row.reason}`
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')

function occurrence(workspace,row,candidate) {
  if(!candidate||candidate.allowAnySourceQuote||!candidate.occurrences?.length)return {state:'no-occurrence-identity'}
  if(!evidenceValid(workspace,row.file,row.evidence,candidate.occurrences))return {state:'invalid-citation'}
  const bytes=readFileSync(resolve(workspace,row.file))
  if(hash(bytes)!==candidate.sha256)return {state:'source-hash-mismatch'}
  const text=bytes.toString(),starts=[0]
  for(let at=text.indexOf('\n');at>=0;at=text.indexOf('\n',at+1))starts.push(at+1)
  const first=starts[row.evidence.startLine-1],window=text.slice(first,starts[row.evidence.endLine]??text.length),matches=[]
  for(let at=window.indexOf(row.evidence.quote);at>=0;at=window.indexOf(row.evidence.quote,at+1)){
    const start=first+at,end=start+row.evidence.quote.length
    matches.push({start,end,spans:candidate.occurrences.filter(span=>start<=span.start&&end>=span.end)})
  }
  // A broad window or quote must not silently select a convenient occurrence.
  if(matches.length!==1||matches[0].spans.length!==1)return {state:'ambiguous-citation',matches}
  const span=matches[0].spans[0]
  return {state:'unique-occurrence',sourceSha256:hash(bytes),start:span.start,end:span.end,quoteStart:matches[0].start,quoteEnd:matches[0].end}
}

export function assessOccurrenceContract(workspace, answer, truth, {integrityPassed=true}={}) {
  const originalGrade=gradeAnswer(workspace,answer,truth)
  if(originalGrade.shape?.passed===false)return {originalGrade,assessedCorrect:false,changedByErratum:false,groups:[],otherFrozenChecksPass:false}
  const projected=structuredClone(answer),groups=[]
  for(const collection of ['exclusions','negativeClaims']){
    const grouped=new Map()
    answer[collection].forEach((row,index)=>{const k=key(row);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push({row,index})})
    const omit=new Set()
    for(const [k,entries] of grouped){
      if(entries.length<2)continue
      const candidates=truth.exclusionCandidates.filter(row=>key(row)===k)
      const proof=entries.map(({row,index})=>({index,...(candidates.length===1?occurrence(workspace,row,candidates[0]):{state:'no-unique-frozen-candidate'})}))
      let state=proof.every(p=>p.state==='unique-occurrence')?'distinct-occurrences':'unresolved-occurrence'
      if(state==='distinct-occurrences')for(let a=0;a<proof.length;a++)for(let b=a+1;b<proof.length;b++)if(proof[a].start<proof[b].end&&proof[b].start<proof[a].end)state='repeated-or-overlapping-occurrence'
      groups.push({collection,key:k,state,proof})
      if(state==='distinct-occurrences')entries.slice(1).forEach(({index})=>omit.add(index))
    }
    projected[collection]=projected[collection].filter((_,index)=>!omit.has(index))
  }
  // Only duplicate-key bookkeeping is projected away, after every row is proved.
  // All identity, set, quote, chain, uncertainty and unrelated negative checks remain frozen.
  const remainingGrade=gradeAnswer(workspace,projected,truth)
  const assessedCorrect=integrityPassed&&remainingGrade.passed&&groups.every(g=>g.state==='distinct-occurrences')
  return {schemaVersion:1,originalGrade,assessedCorrect,changedByErratum:assessedCorrect&&!originalGrade.passed,integrityPassed,otherFrozenChecksPass:remainingGrade.passed,groups,policy:'Separate post-study contract assessment. Only coarse exclusion-key collisions among distinct unambiguous frozen source occurrences may be exonerated. Original answers, truth sets, strict grades and decision thresholds remain unchanged.'}
}
