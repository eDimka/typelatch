import { readFileSync, existsSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import { validateAnswerShape } from './answer-schema.mjs'

const directKey=row=>`${row.file}|${row.symbol}|${row.role}`
const targetKey=row=>`${row.package}|${row.script}`
function compare(actual,expected,key) {
  const proposed=actual.map(key),truth=new Set(expected.map(key)),unique=new Set(proposed)
  const truePositive=[...unique].filter(value=>truth.has(value)),falsePositive=[...unique].filter(value=>!truth.has(value)),falseNegative=[...truth].filter(value=>!unique.has(value))
  return {precision:unique.size?truePositive.length/unique.size:truth.size?0:1,recall:truth.size?truePositive.length/truth.size:1,truePositive,falsePositive,falseNegative,duplicates:proposed.length-unique.size}
}
function evidenceValid(workspace,file,evidence,requiredLines) {
  try {
    if(isAbsolute(file)||file.split(/[\\/]/u).includes('..'))return false
    const full=resolve(workspace,file),real=realpathSync(full)
    if(relative(realpathSync(workspace),real).startsWith('..'))return false
    if(!Number.isInteger(evidence?.startLine)||!Number.isInteger(evidence?.endLine)||evidence.startLine<1||evidence.endLine<evidence.startLine||evidence.endLine-evidence.startLine>20||typeof evidence.quote!=='string'||evidence.quote.trim().length<3)return false
    const lines=readFileSync(full,'utf8').split(/\r?\n/u),slice=lines.slice(evidence.startLine-1,evidence.endLine).join('\n')
    if(evidence.endLine>lines.length)return false
    for(let offset=slice.indexOf(evidence.quote);offset>=0;offset=slice.indexOf(evidence.quote,offset+1)) {
      const first=evidence.startLine+slice.slice(0,offset).split('\n').length-1,last=first+evidence.quote.split('\n').length-1
      if(!requiredLines||requiredLines.some(line=>line>=first&&line<=last))return true
    }
    return false
  }catch{return false}
}

export function gradeAnswer(workspace,answer,truth) {
  const shape=validateAnswerShape(answer)
  if(!shape.passed)return {passed:false,precision:0,recall:0,shape}
  const direct=compare(answer.direct,truth.direct,directKey),dependents=compare(answer.packageDependents,truth.packageDependents.map(packageName=>({package:packageName})),row=>row.package),targets=compare(answer.validationTargets,truth.validationTargets,targetKey)
  const identity=answer.target.package===truth.target.package&&answer.target.version===truth.target.version&&JSON.stringify([...answer.target.exports].sort())===JSON.stringify([...truth.target.exports].sort())
  const directEvidence=answer.direct.map(row=>{
    const expected=truth.direct.find(value=>directKey(value)===directKey(row))
    const namesSymbol=expected?.occurrences.some(item=>row.evidence.quote?.includes(item.localName)||(item.route&&row.evidence.quote?.includes(item.route)&&row.evidence.quote?.includes('export')))
    return {key:directKey(row),passed:!!expected&&row.package===expected.package&&namesSymbol&&evidenceValid(workspace,row.file,row.evidence,expected.occurrences.map(item=>item.line))}
  })
  const packageEvidence=answer.packageDependents.map(row=>({package:row.package,passed:row.chain[0]===row.package&&row.chain.at(-1)===truth.target.package&&new Set(row.chain).size===row.chain.length&&row.chain.slice(0,-1).every((from,index)=>truth.packageGraph.some(edge=>edge.from===from&&edge.to===row.chain[index+1]))}))
  const targetEvidence=answer.validationTargets.map(row=>{const expected=truth.validationTargets.find(value=>targetKey(value)===targetKey(row));return {key:targetKey(row),passed:!!expected&&row.evidence.file===expected.manifest&&evidenceValid(workspace,row.evidence.file,row.evidence,expected.lines)&&row.evidence.quote.includes(`"${row.script}"`)}})
  const exclusionKey=row=>`${row.file}|${row.symbol}|${row.reason}`
  const exclusions=compare(answer.exclusions,truth.exclusions,exclusionKey)
  const exclusionEvidence=answer.exclusions.map(row=>{const expected=truth.exclusions.find(value=>exclusionKey(value)===exclusionKey(row));return {key:exclusionKey(row),passed:!!expected&&evidenceValid(workspace,row.file,row.evidence,expected.lines)}})
  const uncertaintyCodes=new Set(answer.uncertainties.map(row=>row.code)),uncertainties=truth.requiredUncertainties.every(code=>uncertaintyCodes.has(code))
  const falseConfidentNegatives=answer.negativeClaims.filter(row=>!truth.exclusions.some(value=>value.file===row.file&&value.symbol===row.symbol))
  const sets=[direct,dependents,targets,exclusions],precision=sets.reduce((sum,row)=>sum+row.precision,0)/sets.length,recall=sets.reduce((sum,row)=>sum+row.recall,0)/sets.length
  const evidenceChecks=[...directEvidence,...packageEvidence,...targetEvidence,...exclusionEvidence]
  return {passed:identity&&sets.every(row=>row.precision===1&&row.recall===1&&row.duplicates===0)&&evidenceChecks.every(row=>row.passed)&&uncertainties&&falseConfidentNegatives.length===0,
    precision,recall,identity,direct,dependents,targets,exclusions,evidenceChecks,uncertainties,falseConfidentNegatives}
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
