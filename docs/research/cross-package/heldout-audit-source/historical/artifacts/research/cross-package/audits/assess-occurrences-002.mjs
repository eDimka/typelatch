import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { assessOccurrenceContract } from './occurrence-contract-v1.mjs'

const cross=resolve(import.meta.dirname,'..'),dir=join(cross,'impact-confirmation-002')
const hash=x=>createHash('sha256').update(x).digest('hex'),read=p=>readFileSync(p),json=p=>JSON.parse(read(p))
const reportBytes=read(join(dir,'report-private.json')),report=JSON.parse(reportBytes),protocolBytes=read(join(dir,'protocol.json'))
assert.equal(report.complete,true);assert.equal(hash(protocolBytes),report.protocolSha256)
const bindings=new Map(),bind=p=>{const b=read(p),expected=report.protocol.inputs.find(x=>x.path===p);assert(expected);assert.equal(hash(b),expected.sha256);bindings.set(relative(cross,p),{path:relative(cross,p),sha256:hash(b)});return JSON.parse(b)}
const originals=['report-private.json','protocol.json','workflow-audit.json','adjudicated-result.json','correctness-audit.json'].map(path=>({path,sha256:hash(read(join(dir,path)))}))
const rows=[]
for(const run of report.runs){
  const rb=read(join(dir,'runs',run.id,'public-evidence.json')),record=JSON.parse(rb)
  assert.equal(hash(rb),run.evidenceSha256)
  const artifact=record.taskArtifacts.find(x=>x.path==='impact-answer.json')??record.taskArtifacts[0];assert.equal(hash(artifact.text),artifact.sha256)
  const fixture=report.protocol.spec.fixtures[run.task],truth=bind(join(dirname(fixture.graderModule),'truth.json')),initial=bind(fixture.initialManifest)
  const answer=JSON.parse(artifact.text),initialMap=new Map(initial.entries.map(e=>[e.path,e])),sourceFiles=new Set([...answer.direct,...answer.validationTargets,...answer.exclusions,...answer.negativeClaims].map(row=>row.evidence.file??row.file))
  for(const file of sourceFiles)assert.equal(hash(read(join(fixture.workspace,file))),initialMap.get(file)?.sha256)
  const integrityPassed=record.grading.fixtureGitUnchanged===true&&record.grading.integrity.changed.length===0
  const assessment=assessOccurrenceContract(fixture.workspace,answer,truth,{integrityPassed})
  assert.equal(assessment.originalGrade.passed,run.correct)
  for(const [key,value] of Object.entries(assessment.originalGrade))assert.deepEqual(value,record.grading[key])
  rows.push({id:run.id,evidenceSha256:run.evidenceSha256,toolOutputsSha256:run.toolOutputsSha256,answerSha256:artifact.sha256,originalCorrect:run.correct,assessedCorrect:assessment.assessedCorrect,changedByErratum:assessment.changedByErratum,classification:assessment.changedByErratum?'distinct-occurrence-collision-only':assessment.assessedCorrect?'strict-pass-confirmed':'substantive-error-retained',assessment})
}
assert.equal(rows.filter(x=>x.originalCorrect).length,11)
assert.equal(rows.filter(x=>x.changedByErratum).length,4)
assert.equal(rows.filter(x=>x.assessedCorrect).length,15)
assert.equal(rows.find(x=>x.id==='vue-runtime-impact-heldout-grading-v2-r1-native').assessedCorrect,false)
const implementation=['occurrence-contract-v1.mjs','occurrence-contract-v1.test.mjs','assess-occurrences-002.mjs','occurrence-contract-red-001.tap','occurrence-contract-green-001.tap'].map(path=>({path:'audits/'+path,sha256:hash(read(join(import.meta.dirname,path)))}))
const result={schemaVersion:1,reportSha256:hash(reportBytes),protocolSha256:hash(protocolBytes),reviewer:'benchmark_review',noPrivateReasoningOrMessages:true,originalGradesUnchanged:true,originalDecisionsUnchanged:true,assessmentKind:'Post-study contract correction, not replacement preregistered qualification',policy:'Apply the same distinct-occurrence rule to exclusions and negativeClaims in every submitted answer. Every colliding row must uniquely identify a separate nonoverlapping frozen source occurrence. All other frozen checks and source integrity must pass. Ambiguous matches, repeated citations and unsupported source-scope duplicates remain rejected.',summary:{answers:rows.length,originalStrictPass:11,assessedPass:15,occurrenceOnlyExonerations:4,substantiveFailuresRetained:1},conclusion:'Four strict failures were solely an exclusion occurrence identity defect. Native runtime repeat 1 remains incorrect because its external development-dependency chain is invalid. The unchanged original economic gate fails the 20 percent token-saving threshold versus native tools, so this assessment does not establish a qualified edge.',runs:rows,implementation,frozenBindings:[...bindings.values()],preservedOriginals:originals}
writeFileSync(join(dir,'occurrence-assessment-v1.json'),JSON.stringify(result,null,2)+'\n')
writeFileSync(join(dir,'occurrence-assessment-v1.md'),'The frozen grader rejected distinct valid literal occurrences because its duplicate key contained only file, symbol and reason. The prompt defined exclusions by occurrence. A separate assessment now requires each colliding citation to identify one unique frozen source occurrence and rejects repeat citations, overlapping occurrences and ambiguous quotes. Every other frozen check remains in force.\n\nApplied uniformly to all 16 submitted answers, this exonerates four occurrence-only failures and leaves one substantive native dependency-chain error. Original results remain 11 strict passes; the separate contract assessment finds 15 valid answers. Native runtime repeat 1 incorrectly follows monaco-editor 0.52.0 development metadata requiring vite ^3.2.8 to the root installed vite 5.4.0. That lookup is not a valid declared installed dependency edge.\n\nThe original reports, grades and decisions are unchanged. Candidate token savings versus native are below the frozen 20 percent threshold. This correction does not establish a qualified edge.\n')
for(const row of originals)assert.equal(hash(read(join(dir,row.path))),row.sha256)
console.log(JSON.stringify({path:relative(cross,join(dir,'occurrence-assessment-v1.json')),sha256:hash(read(join(dir,'occurrence-assessment-v1.json'))),summary:result.summary}))
