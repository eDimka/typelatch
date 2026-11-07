import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { gradeAnswer } from '../impact/grading-v2/grade-answer.mjs'
import { uncertaintyStates } from '../impact/grading-v2/answer-schema.mjs'
import { assessOccurrenceContract } from './occurrence-contract-v1.mjs'

const text="const first = 'helper';\nconst second = 'helper';\nconst untouched = 3;\n"
const hash=x=>createHash('sha256').update(x).digest('hex')
function fixture(t){
  const workspace=mkdtempSync(join(tmpdir(),'occurrence-contract-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));writeFileSync(join(workspace,'source.ts'),text)
  const occurrences=[...text.matchAll(/'helper'/gu)].map(m=>({start:m.index,end:m.index+m[0].length}))
  const candidate={file:'source.ts',symbol:'helper',reason:'string-or-comment-only',sha256:hash(text),occurrences}
  const truth={target:{package:'target',version:'1',exports:['helper']},packages:[{name:'target',version:'1'}],direct:[],packageDependents:[],packageGraph:[],validationTargets:[],exclusions:[candidate],exclusionCandidates:[candidate],scope:{frozenNonProductionSources:['source.ts']}}
  const rows=[1,2].map(line=>({file:'source.ts',symbol:'helper',reason:'string-or-comment-only',evidence:{startLine:line,endLine:line,quote:text.split('\n')[line-1]}}))
  const answer={schemaVersion:2,target:truth.target,direct:[],packageDependents:[],validationTargets:[],exclusions:rows,negativeClaims:[],uncertainties:Object.entries(uncertaintyStates).map(([code,state])=>({code,state}))}
  return {workspace,truth,answer,assess:()=>assessOccurrenceContract(workspace,answer,truth)}
}
test('distinct valid literal occurrences expose original collision and pass only separate assessment',t=>{const f=fixture(t);assert.equal(gradeAnswer(f.workspace,f.answer,f.truth).passed,false);const a=f.assess();assert.equal(a.assessedCorrect,true);assert.equal(a.originalGrade.passed,false);assert.equal(a.changedByErratum,true);assert.equal(a.groups[0].state,'distinct-occurrences')})
test('same quote repeated for the same occurrence remains rejected',t=>{const f=fixture(t);f.answer.exclusions[1]=structuredClone(f.answer.exclusions[0]);assert.equal(f.assess().assessedCorrect,false)})
test('different overlapping ranges cannot turn the same occurrence into two',t=>{const f=fixture(t);f.answer.exclusions[1]={...structuredClone(f.answer.exclusions[0]),evidence:{startLine:1,endLine:2,quote:"'helper'"}};assert.equal(f.assess().assessedCorrect,false)})
test('one broad quote covering both occurrences is ambiguous',t=>{const f=fixture(t);f.answer.exclusions[0].evidence={startLine:1,endLine:2,quote:text.split('\n').slice(0,2).join('\n')};assert.equal(f.assess().assessedCorrect,false)})
test('a repeated short quote with two possible matches is ambiguous',t=>{const f=fixture(t);f.answer.exclusions[0].evidence={startLine:1,endLine:2,quote:"'helper'"};assert.equal(f.assess().assessedCorrect,false)})
test('a wrong citation cannot disappear when collapsing a coarse key',t=>{const f=fixture(t);f.answer.exclusions[1].evidence.quote='const absent = 0;';assert.equal(f.assess().assessedCorrect,false)})
test('unchanged truth and exact source hash are required',t=>{const f=fixture(t);writeFileSync(join(f.workspace,'source.ts'),text+'// changed\n');assert.equal(f.assess().assessedCorrect,false)})
test('source-scope rows without occurrence identity are not exonerated',t=>{const f=fixture(t);f.truth.exclusions=[];f.answer.exclusions=f.answer.exclusions.map(r=>({...r,symbol:'*',reason:'outside-source-scope'}));assert.equal(f.assess().assessedCorrect,false)})
test('false dependency chain remains rejected despite valid separate occurrences',t=>{const f=fixture(t);f.answer.packageDependents=[{package:'invented',chain:['invented','target']}];assert.equal(f.assess().assessedCorrect,false)})
test('source integrity failure cannot be repaired by the occurrence assessment',t=>{const f=fixture(t);assert.equal(assessOccurrenceContract(f.workspace,f.answer,f.truth,{integrityPassed:false}).assessedCorrect,false)})
test('negativeClaims use the same occurrence rule and retain repeated-claim rejection',t=>{const f=fixture(t);f.truth.exclusions=[];f.answer.negativeClaims=f.answer.exclusions;f.answer.exclusions=[];assert.equal(f.assess().assessedCorrect,true);f.answer.negativeClaims[1]=structuredClone(f.answer.negativeClaims[0]);assert.equal(f.assess().assessedCorrect,false)})
test('different-symbol exclusion slots need distinct admitted occurrences',t=>{const f=fixture(t);f.truth.exclusions[0].reason='different-symbol';f.truth.exclusions[0].binding={declarations:[{file:'source.ts',start:0,end:text.length}]};f.answer.exclusions.forEach(r=>r.reason='different-symbol');assert.equal(f.assess().assessedCorrect,true)})
test('otherwise passing answer remains passing without rewriting the input',t=>{const f=fixture(t);f.answer.exclusions.pop();const before=JSON.stringify(f.answer);assert.equal(f.assess().assessedCorrect,true);assert.equal(f.assess().changedByErratum,false);assert.equal(JSON.stringify(f.answer),before)})
test('malformed answer stays rejected',t=>{const f=fixture(t);f.answer.uncheckedClaim='all consumers unaffected';assert.equal(f.assess().assessedCorrect,false)})
