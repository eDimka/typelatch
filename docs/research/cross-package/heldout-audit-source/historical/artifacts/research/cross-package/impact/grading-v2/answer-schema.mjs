export const uncertaintyStates = Object.freeze({
  'external-consumers':'unknown',
  'dynamic-loading':'unknown',
  'package-reachability-not-symbol-use':'conservative',
  'unexecuted-validation':'not-proven',
})
export const answerSchema = {
  schemaVersion:2,
  target:{package:'exact package name',version:'exact workspace version',exports:['public export name']},
  direct:[{file:'repository relative configured production source',package:'owning package name',symbol:'original public export name',role:'runtime | type-only | reexport',evidence:{startLine:1,endLine:1,quote:'exact source covering the reference token'}}],
  packageDependents:[{package:'workspace package name, optionally followed by @exact-version',chain:['dependent package','intermediate dependency if any','target package']}],
  validationTargets:[{package:'owning package name or <root>',script:'actual scripts object key',evidence:{file:'package.json path',startLine:1,endLine:1,quote:'exact scripts property name and command value'}}],
  exclusions:[{file:'repository relative path',symbol:'declared/imported local name, literal target name, or * for configuration exclusions',reason:'different-symbol | string-or-comment-only | outside-source-scope',evidence:{startLine:1,endLine:1,quote:'exact declaration/import binding, literal/comment or excluded source'}}],
  uncertainties:Object.entries(uncertaintyStates).map(([code,state])=>({code,state})),
  negativeClaims:[],
}
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key))
const strings=value=>Array.isArray(value)&&value.every(item=>typeof item==='string')
function evidence(value,file=false){return keys(value,file?['file','startLine','endLine','quote']:['startLine','endLine','quote'])&&Number.isInteger(value.startLine)&&Number.isInteger(value.endLine)&&typeof value.quote==='string'&&(!file||typeof value.file==='string')}
export function validateAnswerShape(answer) {
  const errors=[]
  if(!keys(answer,['schemaVersion','target','direct','packageDependents','validationTargets','exclusions','uncertainties','negativeClaims'])||answer.schemaVersion!==2)errors.push('Only documented v2 fields are allowed')
  if(!keys(answer?.target,['package','version','exports'])||typeof answer.target.package!=='string'||typeof answer.target.version!=='string'||!strings(answer.target.exports))errors.push('Invalid target identity')
  for(const name of ['direct','packageDependents','validationTargets','exclusions','uncertainties','negativeClaims'])if(!Array.isArray(answer?.[name]))errors.push(`${name} must be an array`)
  for(const row of Array.isArray(answer?.direct)?answer.direct:[])if(!keys(row,['file','package','symbol','role','evidence'])||!['runtime','type-only','reexport'].includes(row.role)||!['file','package','symbol'].every(key=>typeof row[key]==='string')||!evidence(row.evidence))errors.push('Invalid direct row')
  for(const row of Array.isArray(answer?.packageDependents)?answer.packageDependents:[])if(!keys(row,['package','chain'])||typeof row.package!=='string'||!strings(row.chain)||row.chain.length<2)errors.push('Invalid dependent row')
  for(const row of Array.isArray(answer?.validationTargets)?answer.validationTargets:[])if(!keys(row,['package','script','evidence'])||typeof row.package!=='string'||typeof row.script!=='string'||!evidence(row.evidence,true))errors.push('Invalid validation row')
  for(const row of [...(Array.isArray(answer?.exclusions)?answer.exclusions:[]),...(Array.isArray(answer?.negativeClaims)?answer.negativeClaims:[])])if(!keys(row,['file','symbol','reason','evidence'])||!['file','symbol'].every(key=>typeof row[key]==='string')||!['different-symbol','string-or-comment-only','outside-source-scope'].includes(row.reason)||!evidence(row.evidence))errors.push('Invalid exclusion or negative claim')
  for(const row of Array.isArray(answer?.uncertainties)?answer.uncertainties:[])if(!keys(row,['code','state'])||typeof row.code!=='string'||row.state!==uncertaintyStates[row.code])errors.push('Uncertainty must use a documented code and its supported state; prose is not accepted')
  return {passed:errors.length===0,errors}
}
