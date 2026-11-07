import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { deriveOracle } from './compiler-oracle.mjs'
import { scriptPropertyEvidence } from './script-evidence.mjs'
import { answerSchema, uncertaintyStates } from './answer-schema.mjs'
import { gradeAnswer } from './grade-answer.mjs'

const read=path=>JSON.parse(readFileSync(path,'utf8'))
const hash=value=>createHash('sha256').update(value).digest('hex')
export function prepareV2({previousDescriptor,previousTruth,previousGold,workspaceReceipt,out}) {
  out=resolve(out);mkdirSync(out,{recursive:true})
  const descriptor=read(previousDescriptor),old=read(previousTruth),gold=read(previousGold),workspace=descriptor.workspace
  const truth=deriveOracle({workspace,workspaceReceipt,targetPackage:old.target.package,exports:old.target.exports,entry:old.target.entry,config:old.scope.config})
  const key=row=>`${row.file}|${row.symbol}|${row.role}`
  assert.deepEqual(truth.direct.map(key),old.direct.map(key),'V2 cannot change the frozen direct target set')
  assert.deepEqual(truth.packageDependents,old.packageDependents,'V2 cannot change the frozen dependent set')
  const ts=createRequire(join(workspace,'package.json'))('typescript')
  truth.validationTargets=old.validationTargets.map(row=>{
    const text=readFileSync(join(workspace,row.manifest),'utf8'),property=scriptPropertyEvidence(ts,text,row.script)
    assert.equal(read(join(workspace,row.manifest)).scripts[row.script],property.command)
    return {package:row.package,script:row.script,manifest:row.manifest,property,lines:[property.line]}
  })
  truth.exclusions=old.exclusions.map(row=>{
    const candidate=truth.exclusionCandidates.find(candidate=>candidate.file===row.file&&candidate.symbol===row.symbol&&candidate.reason===row.reason)
    assert(candidate,`Required exclusion lacks independent source identity: ${row.file} ${row.symbol}`)
    return {file:row.file,symbol:row.symbol,reason:row.reason}
  })
  truth.schemaVersion=2
  const initial=read(descriptor.initialManifest),production=new Set(truth.scope.productionSourceFiles)
  truth.scope.frozenNonProductionSources=initial.entries.filter(row=>row.kind==='file'&&/\.[cm]?[jt]sx?$/u.test(row.path)&&!production.has(row.path)).map(row=>row.path).sort()
  truth.uncertaintyStates=uncertaintyStates
  truth.nativeDependentFilterAgreement=old.nativeDependentFilterAgreement
  truth.derivation={version:2,originalTruthSha256:hash(readFileSync(previousTruth)),targetSetUnchanged:true,dependentSetUnchanged:true,scriptEvidence:'Exact JSON scripts property syntax span',extraExclusions:'Verified distinct declaration/import symbol, literal/comment or native configuration exclusion',uncertainty:'Constrained state values; no freeform prose'}
  gold.schemaVersion=2
  gold.uncertainties=Object.entries(uncertaintyStates).map(([code,state])=>({code,state}))
  gold.validationTargets=truth.validationTargets.map(row=>({package:row.package,script:row.script,evidence:{file:row.manifest,startLine:row.property.line,endLine:row.property.endLine,quote:row.property.quote}}))
  assert.equal(gradeAnswer(workspace,gold,truth).passed,true,'V2 independent gold must pass')
  const write=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value,null,2)+'\n')
  write('truth.json',truth);write('gold-answer.json',gold);write('answer-schema.json',answerSchema)
  const graderImport=relative(out,join(import.meta.dirname,'grade-answer.mjs')).replaceAll('\\','/')
  writeFileSync(join(out,'grader.mjs'),`import { readFileSync } from 'node:fs'\nimport { gradeFixture } from ${JSON.stringify(graderImport.startsWith('.')?graderImport:'./'+graderImport)}\nconst truth=JSON.parse(readFileSync(new URL('./truth.json',import.meta.url)))\nexport function gradeWorkspace(workspace,initial) { return gradeFixture(workspace,initial,truth,'impact-answer.json') }\n`)
  const originalBody=descriptor.description.split('Answer schema (illustrative values, not expected facts):')[0]+'\nIdentity scope: analyze changes to the underlying declarations defined by the target package, following aliases and public reexports of those declarations. The qualified targets are independently checked to have distinct declarations in that defining package.\n'
  const prompt=originalBody+'\nV2 evidence rules: a quote must cover the exact reference token or the actual JSON scripts property name and command. Additional exclusions are allowed when they cite a distinct compiler-resolved declaration/import binding, a literal/comment occurrence, or source outside the frozen configured production scope. Use symbol * for source-scope exclusions. An exclusion is about that symbol occurrence or source scope, never a blanket claim that its file or package is unaffected. Package-chain labels may be bare names or exact frozen name@version labels. Uncertainty is represented only by the four code/state pairs shown below. Do not add freeform uncertainty prose or undocumented answer fields.\n\nAnswer schema (illustrative values, not expected facts):\n'+JSON.stringify(answerSchema,null,2)
  writeFileSync(join(out,'prompt.txt'),prompt+'\n')
  const qualification={status:'qualified',version:2,previousQualification:descriptor.qualification,sourceFixtureUnchanged:true,initialManifest:descriptor.initialManifest,truthSha256:hash(readFileSync(join(out,'truth.json'))),goldPassed:true,independentSourceDerivation:true,agentTrials:0,graderInputs:['grade-answer.mjs','answer-schema.mjs','compiler-oracle.mjs','script-evidence.mjs','prepare.mjs'].map(file=>({path:join(import.meta.dirname,file),sha256:hash(readFileSync(join(import.meta.dirname,file)))}))}
  write('qualification.json',qualification)
  write('descriptor.json',{...descriptor,id:descriptor.id+'-grading-v2',description:prompt,qualification:join(out,'qualification.json'),graderModule:join(out,'grader.mjs'),publicCases:{answerSchema:join(out,'answer-schema.json')},gradingVersion:2,previousDescriptor,policy:[...(descriptor.policy??[]),'V2 grading is prospective. Original trial grades and source fixtures are unchanged.','Only constrained uncertainty states are accepted; unsupported certainty cannot be added as unchecked answer prose.']})
  return {out,status:'qualified',sourceFixtureUnchanged:true,additionalExclusionCandidates:truth.exclusionCandidates.length}
}
