export const answerSchema = {
  schemaVersion: 1,
  target: { package: 'exact package name', version: 'exact workspace version', exports: ['public export name'] },
  direct: [{ file: 'repository relative configured production source', package: 'owning package name', symbol: 'original public export name', role: 'runtime | type-only | reexport', evidence: { startLine: 1, endLine: 1, quote: 'exact source within these lines' } }],
  packageDependents: [{ package: 'workspace package name', chain: ['dependent package', 'intermediate dependency if any', 'target package'] }],
  validationTargets: [{ package: 'owning package name or <root>', script: 'actual package.json script', evidence: { file: 'package.json path', startLine: 1, endLine: 1, quote: 'exact script entry' } }],
  exclusions: [{ file: 'repository relative path', symbol: 'lookalike name or *', reason: 'different-symbol | string-or-comment-only | outside-source-scope', evidence: { startLine: 1, endLine: 1, quote: 'exact relevant source' } }],
  uncertainties: [{ code: 'external-consumers | dynamic-loading | package-reachability-not-symbol-use | unexecuted-validation', detail: 'specific limit, not a claim of absence' }],
  negativeClaims: [],
}

export function validateAnswerShape(answer) {
  const errors=[]
  if(answer?.schemaVersion!==1)errors.push('schemaVersion must equal 1')
  if(typeof answer?.target?.package!=='string'||typeof answer?.target?.version!=='string'||!Array.isArray(answer?.target?.exports))errors.push('target package, version and exports required')
  for(const key of ['direct','packageDependents','validationTargets','exclusions','uncertainties','negativeClaims'])if(!Array.isArray(answer?.[key]))errors.push(`${key} must be an array`)
  for(const row of answer?.direct??[])if(!['runtime','type-only','reexport'].includes(row.role)||!row.file||!row.package||!row.symbol||!row.evidence)errors.push('invalid direct row')
  for(const row of answer?.packageDependents??[])if(!row.package||!Array.isArray(row.chain)||row.chain.length<2)errors.push('invalid dependent row')
  for(const row of answer?.validationTargets??[])if(!row.package||!row.script||!row.evidence?.file)errors.push('invalid validation target')
  for(const row of answer?.exclusions??[])if(!row.file||!row.symbol||!['different-symbol','string-or-comment-only','outside-source-scope'].includes(row.reason)||!row.evidence)errors.push('invalid exclusion')
  for(const row of answer?.uncertainties??[])if(!row.code||typeof row.detail!=='string'||row.detail.trim().length<15)errors.push('invalid uncertainty')
  return {passed:errors.length===0,errors}
}
