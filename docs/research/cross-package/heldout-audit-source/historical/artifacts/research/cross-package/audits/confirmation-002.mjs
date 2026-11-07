import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { reviewRules, adjudicate } from '../trial/review.mjs'
import { gradeAnswer, canonicalPackage } from '../impact/grading-v2/grade-answer.mjs'

const cross = resolve(import.meta.dirname, '..'), dir = join(cross, 'impact-confirmation-002')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => readFileSync(path), json = path => JSON.parse(read(path))
const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n')
const reportBytes = read(join(dir, 'report-private.json')), protocolBytes = read(join(dir, 'protocol.json')), report = JSON.parse(reportBytes)
assert.equal(report.complete, true); assert.equal(report.runs.length, 16)
const judgments = json(join(import.meta.dirname, 'confirmation-002-judgments.json'))
assert.equal(Object.keys(judgments.runs).length, 16)
const records = new Map(), outputs = new Map(), sourceBindings = new Map(), frozenBindings = new Map()
const bound = path => { const bytes = read(path), expected = report.protocol.inputs.find(x => x.path === path); assert(expected, path); assert.equal(hash(bytes), expected.sha256); frozenBindings.set(relative(cross,path),{path:relative(cross,path),sha256:hash(bytes)}); return JSON.parse(bytes) }
const truths = new Map(report.protocol.tasks.map(task => { const fixture = report.protocol.spec.fixtures[task.id]; const path = join(resolve(fixture.graderModule,'..'),'truth.json'); return [task.id,{truth:bound(path),fixture,initial:bound(fixture.initialManifest)}] }))
const audit = {schemaVersion:1,reportSha256:hash(reportBytes),protocolSha256:hash(protocolBytes),rules:reviewRules,reviewer:'benchmark_review',noPrivateReasoningOrMessages:true,method:'Review every completed public command, relevant exact tool outputs and explicit answer artifacts. Inspect action start/completion times and shell ordering. Source, quote, script-property and installed-edge checks are recorded separately. No raw captures, reasoning or assistant message bodies were inspected. Original correctness and gates remain unchanged.',runs:[]}
const analyses=[]
for (const run of report.runs) {
  const runDir=join(dir,'runs',run.id), rb=read(join(runDir,'public-evidence.json')), ob=read(join(runDir,'tool-outputs.json')), record=JSON.parse(rb), supplement=JSON.parse(ob), j=judgments.runs[run.id]
  assert.equal(hash(rb),run.evidenceSha256);assert.equal(hash(ob),run.toolOutputsSha256)
  records.set(run.id,rb);outputs.set(run.id,ob)
  assert.equal(run.capture.complete,true);assert.equal(run.processGroupStopped,true);assert.equal(run.providerStopped,true)
  assert.equal(run.usage.totalTokens,run.usage.inputTokens+run.usage.outputTokens)
  assert.equal(record.grading.fixtureGitUnchanged,true);assert.deepEqual(record.grading.integrity.changed,[])
  const copyBytes=read(join(runDir,'fixture-copy.json')),copy=JSON.parse(copyBytes)
  assert.equal(hash(copyBytes),run.fixtureCopy.sha256)
  assert.equal(run.fixtureCopy.helperSha256,'bee29ed626ad71ab4e5985b8faef8fe6a08a47cb38982e4f806809a50f1a571b')
  assert.equal(run.fixtureCopy.pythonSha256,'4f37cb0cfa3d35408312e2d76c821b6c86b3331ea9fb795d82508bfbff2ece8d')
  assert.equal(run.fixtureCopy.clonedFiles,18328);assert.equal(run.fixtureCopy.clonedSymlinks,1576);assert.deepEqual(run.fixtureCopy.excludedGit,[])
  const first=record.actions[j.firstInvestigationIndex]
  audit.runs.push({id:run.id,evidenceSha256:run.evidenceSha256,toolOutputsSha256:run.toolOutputsSha256,workflow:j.workflow,providerEvidence:j.providerEvidence,notes:j.notes,basisActionIds:record.actions.map(a=>a.idSha256),providerActionIds:j.providerIndices.map(i=>record.actions[i].idSha256),firstInvestigation:{actionIdSha256:first.idSha256,startedMs:first.startedMs,completedMs:first.completedMs},sourceIntegrity:{changed:[],fixtureGitUnchanged:true},fixtureCopy:{sha256:hash(copyBytes),mechanism:copy.mechanism??copy.copy?.mechanism??null},providerProof:j.providerIndices.map(i=>{const a=record.actions[i],o=supplement.actions.find(x=>x.idSha256===a.idSha256);return {actionIdSha256:a.idSha256,tool:a.tool,resultSha256:a.resultSha256,resultPointer:'/result/content/0/text',excerpt:o.result.content[0].text.slice(0,700)}})})
  const {truth,fixture,initial}=truths.get(run.task), initialMap=new Map(initial.entries.map(x=>[x.path,x])),workspace=fixture.workspace
  const source=file=>{const b=read(join(workspace,file));assert.equal(hash(b),initialMap.get(file)?.sha256,file);sourceBindings.set(run.task+'|'+file,{task:run.task,path:file,sha256:hash(b)});return b.toString()}
  const artifact=record.taskArtifacts.find(x=>x.path==='impact-answer.json')??record.taskArtifacts[0];assert.equal(hash(artifact.text),artifact.sha256)
  const answer=JSON.parse(artifact.text), strict=gradeAnswer(workspace,answer,truth)
  for(const [k,v] of Object.entries(strict))assert.deepEqual(record.grading[k],v,`${run.id}/${k}`)
  const quoteChecks=[...answer.direct,...answer.validationTargets,...answer.exclusions,...answer.negativeClaims].map(row=>{const e=row.evidence,file=e.file??row.file;assert(e.startLine>0&&e.endLine-e.startLine<=20);assert(source(file).split(/\r?\n/u).slice(e.startLine-1,e.endLine).join('\n').includes(e.quote));return {file,startLine:e.startLine,endLine:e.endLine,exact:true}})
  const scriptChecks=answer.validationTargets.map(row=>{const file=row.evidence.file,text=source(file),ast=ts.parseJsonText(file,text),scripts=ast.statements[0].expression.properties.find(p=>p.name.text==='scripts').initializer,property=scripts.properties.find(p=>p.name.text===row.script);assert(property);assert(row.evidence.quote.includes(property.getText(ast)));return {file,script:row.script,jsonPointer:'/scripts/'+row.script,exact:true}})
  const chains=answer.packageDependents.map(row=>{const names=row.chain.map(label=>canonicalPackage(label,truth.packages)),edges=names.slice(0,-1).map((from,index)=>{const to=names[index+1],a=truth.packages.find(x=>x.name===from),b=truth.packages.find(x=>x.name===to);if(!a||!b)return {from,to,valid:false,reason:'Not an exact admitted workspace package identity'};const manifest=JSON.parse(source(join(a.path,'package.json')));const edge=truth.packageGraph.find(e=>e.from===from&&e.to===to&&manifest[e.kind]?.[e.alias]===e.range&&realpathSync(join(workspace,a.path,'node_modules',e.alias))===realpathSync(join(workspace,b.path)));return {from,to,valid:!!edge,...(edge?{alias:edge.alias,kind:edge.kind,range:edge.range}:{reason:'No declared installed workspace edge'})}});return {package:row.package,chain:row.chain,valid:edges.every(e=>e.valid),edges}})
  const finding=judgments.correctnessFindings.find(x=>x.id===run.id)
  analyses.push({id:run.id,evidenceSha256:run.evidenceSha256,answerSha256:artifact.sha256,originalCorrect:run.correct,strictReproduced:strict.passed===run.correct,directEntries:answer.direct.length,dependentEntries:answer.packageDependents.length,quoteChecks,scriptChecks,chains,strictChecks:strict,contractFinding:finding??null,assessment:run.correct?'No substantive correctness issue found':finding?.substantiveFactsPass?'Frozen false result is only the documented occurrence-key collision; separate assessment pending':'Substantive invalid dependency chain remains, in addition to the occurrence-key collision'})
}
save('workflow-audit.json',audit)
save('adjudicated-result.json',adjudicate({reportBytes,protocolBytes,audit,records,outputs}))
save('correctness-audit.json',{schemaVersion:1,reviewer:'benchmark_review',reportSha256:hash(reportBytes),protocolSha256:hash(protocolBytes),noPrivateReasoningOrMessages:true,originalGradesUnchanged:true,method:'Reproduce every strict answer grade against its frozen truth and source. Independently hash each cited file, verify exact quotes, parse scripts properties, and check admitted package chains through declared manifests and installed links. Distinct source occurrences are documented separately; this audit does not replace strict grades or gates.',conclusion:'All 16 workflows conform. Eleven answers strictly pass. Four strict failures arise only from two individually valid, distinct literal occurrences being collapsed to the same exclusion key. Native runtime repeat 1 also proposes a substantively invalid external development-dependency chain and remains incorrect. Two static impact tasks share the same Vue 3.5.13 corpus; they do not establish actual repair or cross-repository savings.',analyses,sourceBindings:[...sourceBindings.values()].sort((a,b)=>(a.task+a.path).localeCompare(b.task+b.path)),frozenBindings:[...frozenBindings.values()],errata:['correctness-erratum-001.json','correctness-native-chain-001.json'].map(path=>({path,sha256:hash(read(join(dir,path)))}))})
writeFileSync(join(dir,'correctness-audit.md'),'All 16 workflows conform to the frozen analysis-only instructions. Every source quote and actual scripts-property citation was checked against frozen bytes. Eleven answers strictly pass. Four failures are caused only by the documented exclusion occurrence collision. Native runtime repeat 1 additionally invents an invalid chain through an external package development dependency and remains incorrect. Original grades and gates are unchanged.\n\nThese are two static impact tasks in the same Vue 3.5.13 corpus. They do not establish successful code migrations, general monorepo superiority or cross-repository replication. A separate versioned occurrence assessment will evaluate the contract defect uniformly without replacing these results.\n')
assert.equal(hash(read(join(dir,'report-private.json'))),hash(reportBytes));assert.equal(hash(read(join(dir,'protocol.json'))),hash(protocolBytes))
console.log(JSON.stringify({reportSha256:hash(reportBytes),workflowAuditSha256:hash(read(join(dir,'workflow-audit.json'))),adjudicatedSha256:hash(read(join(dir,'adjudicated-result.json'))),correctnessAuditSha256:hash(read(join(dir,'correctness-audit.json')))}))
