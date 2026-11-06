import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { gradeAnswer,gradeFixture,canonicalPackage,evidenceValid } from './grade-answer.mjs'
import { uncertaintyStates } from './answer-schema.mjs'
import { scriptPropertyEvidence } from './script-evidence.mjs'
import { inventoryTree } from '../../../../../scripts/paired-agent-integrity.mjs'
const base=resolve('artifacts/research/cross-package/impact'),truth=JSON.parse(readFileSync(join(base,'development-v2/truth.json'))),gold=JSON.parse(readFileSync(join(base,'development-v2/gold-answer.json'))),workspace=truth.workspace
const ts=createRequire(join(workspace,'package.json'))('typescript'),grade=answer=>gradeAnswer(workspace,answer,truth)
const quote=(file,line)=>({startLine:line,endLine:line,quote:readFileSync(join(workspace,file),'utf8').split('\n')[line-1]})

test('independent v2 complete answer passes',()=>assert.equal(grade(gold).passed,true))
test('JSON AST selects scripts.test rather than directories.test',()=>{
 const text='{ "directories": {"test":"wrong"}, "scripts": {"test":"native check"} }',row=scriptPropertyEvidence(ts,text,'test')
 assert.equal(row.command,'native check');assert.equal(text.slice(row.start,row.end),'"test":"native check"');assert.equal(row.jsonPointer,'/scripts/test')
 assert.throws(()=>scriptPropertyEvidence(ts,'{"scripts":{"test":"a","test":"b"}}','test'))
})
test('actual script property passes and matching key under directories fails',()=>{
 const answer=structuredClone(gold),row=answer.validationTargets.find(row=>row.package==='@pnpm/core'&&row.script==='test'),lines=readFileSync(join(workspace,row.evidence.file),'utf8').split('\n')
 assert(row);assert.equal(grade(answer).passed,true)
 const wrong=lines.findIndex((line,index)=>line.includes('"test":')&&index+1!==row.evidence.startLine)+1
 assert(wrong>0);row.evidence={file:row.evidence.file,...quote(row.evidence.file,wrong)};assert.equal(grade(answer).passed,false)
})
test('script quote must include the command value, not just the key',()=>{
 const answer=structuredClone(gold);answer.validationTargets[0].evidence.quote='"'+answer.validationTargets[0].script+'"';assert.equal(grade(answer).passed,false)
})
test('additional local-wrapper import exclusion passes without excluding its consumer file',()=>{
 const answer=structuredClone(gold),file='pkg-manager/core/src/install/index.ts',candidate=truth.exclusionCandidates.find(row=>row.file===file&&row.symbol==='parseWantedDependencies'&&row.reason==='different-symbol')
 assert(candidate);assert(candidate.binding.declarations.some(row=>row.file==='pkg-manager/core/src/parseWantedDependencies.ts'))
 answer.exclusions.push({file,symbol:candidate.symbol,reason:candidate.reason,evidence:quote(file,candidate.occurrences[0].line)})
 const result=grade(answer);assert.equal(result.passed,true);assert.equal(result.exclusions.falsePositive.length,0)
})
test('claiming the actual target import is a different symbol fails',()=>{
 const answer=structuredClone(gold),row=answer.direct.find(row=>row.symbol==='parseWantedDependency')
 answer.exclusions.push({file:row.file,symbol:row.symbol,reason:'different-symbol',evidence:row.evidence});assert.equal(grade(answer).passed,false)
})
test('a valid wrapper exclusion cannot erase a real target use in the same file',()=>{
 const answer=structuredClone(gold),file=answer.exclusions[0].file
 assert(answer.direct.some(row=>row.file===file));answer.direct=answer.direct.filter(row=>row.file!==file);assert.equal(grade(answer).passed,false)
})
test('existing generated declaration can be excluded from production source',()=>{
 const answer=structuredClone(gold),file='packages/parse-wanted-dependency/lib/index.d.ts'
 assert(truth.scope.frozenNonProductionSources.includes(file));answer.exclusions.push({file,symbol:'*',reason:'outside-source-scope',evidence:quote(file,1)});assert.equal(grade(answer).passed,true)
})
test('production source cannot be excluded through a fabricated scope claim',()=>{
 const answer=structuredClone(gold),row=answer.direct[0];answer.exclusions.push({file:row.file,symbol:'*',reason:'outside-source-scope',evidence:row.evidence});assert.equal(grade(answer).passed,false)
})
test('all exact name@version chain labels are equivalent to bare names',()=>{
 const answer=structuredClone(gold),label=name=>name+'@'+truth.packages.find(row=>row.name===name).version
 answer.packageDependents=answer.packageDependents.map(row=>({package:label(row.package),chain:row.chain.map(label)}));assert.equal(grade(answer).passed,true)
})
test('scoped names split only at the last @ and versions must match exactly',()=>{
 const packages=[{name:'@scope/pkg',version:'1.2.3-beta.1'},{name:'plain',version:'2.0.0'}]
 assert.equal(canonicalPackage('@scope/pkg@1.2.3-beta.1',packages),'@scope/pkg')
 for(const label of ['@scope/pkg@1.2.3','@scope/pkg@latest','@scope/pkg@1.2.3-beta.1@evil','plain@^2.0.0','missing@2.0.0'])assert.equal(canonicalPackage(label,packages),null)
})
test('wrong version in otherwise valid chain fails',()=>{
 const answer=structuredClone(gold);answer.packageDependents[0].chain[0]+='@0.0.0';assert.equal(grade(answer).passed,false)
})
test('a version-qualified duplicate does not inflate dependent recall',()=>{
 const answer=structuredClone(gold),row=structuredClone(answer.packageDependents[0]);row.package+='@'+truth.packages.find(pkg=>pkg.name===row.package).version;answer.packageDependents.push(row);assert.equal(grade(answer).passed,false)
})
for(const [name,mutate] of Object.entries({
 'missing direct fact':answer=>answer.direct.pop(),
 'wrong direct role':answer=>{answer.direct[0].role=answer.direct[0].role==='runtime'?'type-only':'runtime'},
 'fabricated source quote':answer=>{answer.direct[0].evidence.quote='source does not contain this assertion'},
 'partial quote on the correct line':answer=>{answer.direct[0].evidence.quote='import'},
 'unsupported negative claim':answer=>{const row=answer.direct[0];answer.negativeClaims.push({file:row.file,symbol:row.symbol,reason:'different-symbol',evidence:row.evidence})},
 'unchecked contradictory uncertainty prose':answer=>{answer.uncertainties[0].detail='All external consumers are proven unaffected'},
 'unsupported certainty state':answer=>{answer.uncertainties[0].state='proven-unaffected'},
 'duplicate uncertainty code':answer=>{answer.uncertainties[0]=answer.uncertainties[1]},
 'unchecked top-level conclusion':answer=>{answer.conclusion='No other packages can be affected'},
}))test(`rejects ${name}`,()=>{const answer=structuredClone(gold);mutate(answer);assert.equal(grade(answer).passed,false)})
test('quote spans preserve UTF16 positions and cannot borrow adjacent-line evidence',()=>{
 const temp=mkdtempSync(join(tmpdir(),'impact-v2-span-')),text='// 😀 prefix\nconst target = 1;\n',file=join(temp,'source.ts'),start=text.indexOf('target');writeFileSync(file,text)
 try{assert.equal(evidenceValid(temp,'source.ts',{startLine:1,endLine:2,quote:'// 😀 prefix'},[{start,end:start+6}]),false);assert.equal(evidenceValid(temp,'source.ts',{startLine:2,endLine:2,quote:'const target = 1;'},[{start,end:start+6}]),true)}finally{rmSync(temp,{recursive:true,force:true})}
})
test('regular answer boundary rejects a symlink outside the workspace',()=>{
 const temp=mkdtempSync(join(tmpdir(),'impact-v2-answer-')),work=join(temp,'workspace');mkdirSync(work)
 const empty={target:{package:'test',version:'1',exports:[]},packages:[{name:'test',version:'1'}],direct:[],packageDependents:[],packageGraph:[],validationTargets:[],exclusions:[],exclusionCandidates:[],scope:{frozenNonProductionSources:[]}}
 const answer={schemaVersion:2,target:empty.target,direct:[],packageDependents:[],validationTargets:[],exclusions:[],uncertainties:Object.entries(uncertaintyStates).map(([code,state])=>({code,state})),negativeClaims:[]}
 try{const initial=inventoryTree(work);writeFileSync(join(temp,'answer.json'),JSON.stringify(answer));symlinkSync('../answer.json',join(work,'impact-answer.json'));assert.equal(gradeFixture(work,initial,empty).passed,false)}finally{rmSync(temp,{recursive:true,force:true})}
})
