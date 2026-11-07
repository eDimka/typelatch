import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { inventoryTree } from '../../../../../scripts/paired-agent-integrity.mjs'
import { validateAnswerShape, uncertaintyStates } from './answer-schema.mjs'

const directKey=row=>`${row.file}|${row.symbol}|${row.role}`
const targetKey=row=>`${row.package}|${row.script}`
const exclusionKey=row=>`${row.file}|${row.symbol}|${row.reason}`
function compare(actual,expected,key) {
  const proposed=actual.map(key),truth=new Set(expected.map(key)),unique=new Set(proposed)
  const truePositive=[...unique].filter(value=>truth.has(value)),falsePositive=[...unique].filter(value=>!truth.has(value)),falseNegative=[...truth].filter(value=>!unique.has(value))
  return {precision:unique.size?truePositive.length/unique.size:truth.size?0:1,recall:truth.size?truePositive.length/truth.size:1,truePositive,falsePositive,falseNegative,duplicates:proposed.length-unique.size}
}
export function canonicalPackage(label,packages) {
  if(typeof label!=='string')return null
  const exact=packages.find(row=>row.name===label)
  if(exact)return exact.name
  const split=label.lastIndexOf('@')
  if(split<=0)return null
  const name=label.slice(0,split),version=label.slice(split+1),pkg=packages.find(row=>row.name===name)
  return pkg&&version===pkg.version?name:null
}
export function evidenceValid(workspace,file,evidence,spans,{allowAnySourceQuote=false}={}) {
  try {
    if(isAbsolute(file)||file.split(/[\\/]/u).includes('..'))return false
    const full=resolve(workspace,file),real=realpathSync(full)
    if(relative(realpathSync(workspace),real).startsWith('..'))return false
    if(!Number.isInteger(evidence?.startLine)||!Number.isInteger(evidence?.endLine)||evidence.startLine<1||evidence.endLine<evidence.startLine||evidence.endLine-evidence.startLine>20||typeof evidence.quote!=='string'||evidence.quote.trim().length<3)return false
    const text=readFileSync(full,'utf8'),lineStarts=[0]
    for(let offset=text.indexOf('\n');offset>=0;offset=text.indexOf('\n',offset+1))lineStarts.push(offset+1)
    if(evidence.endLine>lineStarts.length)return false
    const first=lineStarts[evidence.startLine-1],slice=text.slice(first,lineStarts[evidence.endLine]??text.length)
    for(let offset=slice.indexOf(evidence.quote);offset>=0;offset=slice.indexOf(evidence.quote,offset+1)) {
      const start=first+offset,end=start+evidence.quote.length
      if(allowAnySourceQuote||spans.some(span=>start<=span.start&&end>=span.end))return true
    }
    return false
  }catch{return false}
}
function assessExclusions(workspace,rows,truth) {
  const required=new Set(truth.exclusions.map(exclusionKey)),seen=new Set(),valid=[],invalid=[],evidenceChecks=[]
  let duplicates=0
  for(const row of rows) {
    const key=exclusionKey(row)
    if(seen.has(key))duplicates++
    seen.add(key)
    let candidate=truth.exclusionCandidates.find(item=>exclusionKey(item)===key)
    if(!candidate&&row.reason==='outside-source-scope'&&row.symbol==='*')try {
      const canonicalPath=relative(realpathSync(workspace),realpathSync(resolve(workspace,row.file))).replaceAll('\\','/')
      if(truth.scope.frozenNonProductionSources.includes(canonicalPath))candidate={occurrences:[],allowAnySourceQuote:true}
    }catch{}
    const passed=!!candidate&&evidenceValid(workspace,row.file,row.evidence,candidate.occurrences,{allowAnySourceQuote:candidate.allowAnySourceQuote===true})
    evidenceChecks.push({key,passed})
    if(passed)valid.push(key);else invalid.push(key)
  }
  const uniqueValid=new Set(valid),missing=[...required].filter(key=>!uniqueValid.has(key))
  return {precision:seen.size?uniqueValid.size/seen.size:required.size?0:1,recall:required.size?(required.size-missing.length)/required.size:1,truePositive:[...uniqueValid],falsePositive:[...new Set(invalid)],falseNegative:missing,duplicates,evidenceChecks}
}
export function gradeAnswer(workspace,answer,truth) {
  const shape=validateAnswerShape(answer)
  if(!shape.passed)return {passed:false,precision:0,recall:0,shape}
  const canonical=label=>canonicalPackage(label,truth.packages)
  const normalizedDependents=answer.packageDependents.map(row=>({...row,package:canonical(row.package)??`!invalid:${row.package}`,chain:row.chain.map(label=>canonical(label)??`!invalid:${label}`)}))
  const direct=compare(answer.direct,truth.direct,directKey),dependents=compare(normalizedDependents,truth.packageDependents.map(packageName=>({package:packageName})),row=>row.package),targets=compare(answer.validationTargets,truth.validationTargets,targetKey)
  const identity=answer.target.package===truth.target.package&&answer.target.version===truth.target.version&&JSON.stringify([...answer.target.exports].sort())===JSON.stringify([...truth.target.exports].sort())
  const directEvidence=answer.direct.map(row=>{const expected=truth.direct.find(value=>directKey(value)===directKey(row));return {key:directKey(row),passed:!!expected&&row.package===expected.package&&evidenceValid(workspace,row.file,row.evidence,expected.occurrences)}})
  const packageEvidence=normalizedDependents.map(row=>({package:row.package,passed:row.chain[0]===row.package&&row.chain.at(-1)===truth.target.package&&new Set(row.chain).size===row.chain.length&&row.chain.slice(0,-1).every((from,index)=>truth.packageGraph.some(edge=>edge.from===from&&edge.to===row.chain[index+1]))}))
  const targetEvidence=answer.validationTargets.map(row=>{const expected=truth.validationTargets.find(value=>targetKey(value)===targetKey(row));return {key:targetKey(row),passed:!!expected&&row.evidence.file===expected.manifest&&evidenceValid(workspace,row.evidence.file,row.evidence,[expected.property])}})
  const exclusions=assessExclusions(workspace,answer.exclusions,truth)
  const negativeAssessment=assessExclusions(workspace,answer.negativeClaims,{...truth,exclusions:[]})
  const uncertaintyCodes=answer.uncertainties.map(row=>row.code),uncertainties=Object.keys(uncertaintyStates).length===uncertaintyCodes.length&&new Set(uncertaintyCodes).size===uncertaintyCodes.length&&Object.keys(uncertaintyStates).every(code=>uncertaintyCodes.includes(code))
  const sets=[direct,dependents,targets,exclusions],precision=sets.reduce((sum,row)=>sum+row.precision,0)/sets.length,recall=sets.reduce((sum,row)=>sum+row.recall,0)/sets.length
  const evidenceChecks=[...directEvidence,...packageEvidence,...targetEvidence,...exclusions.evidenceChecks,...negativeAssessment.evidenceChecks]
  return {passed:identity&&sets.every(row=>row.precision===1&&row.recall===1&&row.duplicates===0)&&evidenceChecks.every(row=>row.passed)&&uncertainties&&negativeAssessment.falsePositive.length===0&&negativeAssessment.duplicates===0,
    precision,recall,identity,direct,dependents,targets,exclusions,evidenceChecks,uncertainties,falseConfidentNegatives:negativeAssessment.falsePositive,representation:{packageLabels:'bare name or exact frozen name@version',uncertainty:'constrained code/state pairs; no unchecked prose'}}
}
export function gradeFixture(workspace,initial,truth,answerFile='impact-answer.json') {
  const manifest=typeof initial==='string'?JSON.parse(readFileSync(initial,'utf8')):initial
  const current=inventoryTree(workspace,{excludeDirectories:manifest.excludeDirectories})
  const before=new Map(manifest.entries.filter(row=>row.kind!=='directory').map(row=>[row.path,row])),after=new Map(current.entries.filter(row=>row.kind!=='directory').map(row=>[row.path,row]))
  const changed=[...new Set([...before.keys(),...after.keys()])].filter(path=>path!==answerFile&&JSON.stringify(before.get(path))!==JSON.stringify(after.get(path)))
  let result
  try{const path=resolve(workspace,answerFile),stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||relative(realpathSync(workspace),realpathSync(path)).startsWith('..'))throw Error('Answer must be a regular file inside the workspace');result=gradeAnswer(workspace,JSON.parse(readFileSync(path,'utf8')),truth)}catch(error){result={passed:false,precision:0,recall:0,error:String(error)}}
  return {...result,passed:result.passed&&changed.length===0,integrity:{changed},answerPresent:existsSync(resolve(workspace,answerFile))}
}
