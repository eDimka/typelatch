import test from 'node:test';
import assert from 'node:assert/strict';
import {collectProbe,returnedSources,importsOf,keywordPattern} from './collect.mjs';
const workspace='/scratch/project';
const body='**`src/main.ts`**\n\n```typescript\n1\texport function compute() { return 3; }\n```';
const response=text=>({content:[{type:'text',text}]});

function harness(raw,nativeAnswers={}) {
  const calls=[];
  const native=Object.fromEntries(['read','search','package','configs','manifests'].map(name=>[name,async args=>{calls.push({name,args});const answer=nativeAnswers[name];return typeof answer==='function'?answer(args):answer??{matches:[]};}]));
  return {calls,native,session:{call:async(name,args)=>{calls.push({name,args});return raw;}}};
}
test('source bodies already returned by CodeGraph survive path extraction',()=>{
  assert.match(returnedSources(response(body),workspace)[0].text,/export function compute/);
});
test('source discovery retains CodeGraph current source without redundant reads',async()=>{
  const h=harness(response(body));
  const result=await collectProbe({provider:'codegraph',probe:{id:'scratch',family:'discovery',question:'Locate compute implementation.',context:{}},workspace,...h});
  assert.equal(result.attemptedActions,1);assert.equal(h.calls.filter(x=>x.name==='read').length,0);
});
test('Graphify locations cause bounded source reads',async()=>{
  const h=harness(response('NODE compute() [src=src/main.ts loc=L8]'),{read:{files:[{path:'src/main.ts',text:'export function compute() {}'}]}});
  await collectProbe({provider:'graphify',probe:{id:'scratch',family:'discovery',question:'Locate compute implementation.',context:{}},workspace,...h});
  assert.equal(h.calls[1].name,'read');assert.equal(h.calls[1].args.files[0].path,'src/main.ts');
});
test('negative claims always obtain complete scoped exact-name search',async()=>{
  const h=harness(response('NODE phantom() [src=other/src/main.ts loc=L1]'));
  const result=await collectProbe({provider:'graphify',probe:{id:'negative',family:'negative',question:'Find phantom in requested family.',context:{symbol:'phantom',directories:['target']}},workspace,...h});
  assert.equal(h.calls[1].name,'search');assert.deepEqual(h.calls[1].args.directories,['target']);assert.match(result.notes.join('\n'),/outside requested/);
});
test('installed aliases are resolved from the explicit importing file',async()=>{
  const h=harness(response('unused'),{package:{package:{name:'actual-runner',version:'2.0.0'},declarations:[{text:'export function sync(): void; export type Runner = string;'}]}});
  const probe={id:'alias',family:'installed-api',question:'Report callable sync signature.',context:{file:'env/src/task.ts',importSpecifier:'runner-alias'}};
  const result=await collectProbe({provider:'graphify',probe,workspace,...h});
  assert.deepEqual(h.calls.map(x=>x.name),['package']);assert.equal(h.calls[0].args.importSpecifier,'runner-alias');assert.equal(result.evidence[0].raw.package.name,'actual-runner');
});
test('byte or deadline failures stop subsequent retrieval attempts',async()=>{
  const h=harness(response('unused'));h.session.call=async()=>{h.calls.push({name:'failed'});throw Error('budget text bytes exceeded');};
  const result=await collectProbe({provider:'graphify',probe:{id:'negative',family:'negative',question:'Find absent.',context:{symbol:'absent'}},workspace,...h});
  assert.equal(result.attemptedActions,1);assert.equal(h.calls.length,1);assert.match(result.limitations.join('\n'),/budget/);
});
test('imports and fallback search terms derive only from observed text',()=>{
  assert.deepEqual(importsOf("import { Foo } from 'runner-alias'; const C = require('cache-box');").map(x=>x.specifier),['runner-alias','cache-box']);
  assert.equal(keywordPattern('Locate the production function checking frobnication and widgetization.'),'widgetization|frobnication');
});
test('transitive dependency names and runtime entrypoints come from returned evidence',async()=>{
  const h=harness(response('unused'),{
    read:({files})=>files.length===2?{files:[{path:'one/src/a.ts',text:"import Cache from 'cache-modern';"},{path:'two/src/b.ts',text:"import Host from 'host-metadata';"}]}:{files:[{path:files[0].path,text:"const Cache = require('cache-old');"}]},
    package:({importSpecifier})=>({runtimePath:`node_modules/${importSpecifier}/live.js`,package:{name:importSpecifier,path:`node_modules/${importSpecifier}/package.json`,realPath:`node_modules/${importSpecifier}`,main:'unused.js'},declarations:[{path:`node_modules/${importSpecifier}/index.d.ts`,text:'export class Cache {}'}]}),
  });
  const probe={id:'runtime-edge',family:'installed-api',question:'Compare cache directly imported here with cache used internally by host-metadata. Follow actual installed import edges.',context:{files:['one/src/a.ts','two/src/b.ts']}};
  await collectProbe({provider:'graphify',probe,workspace,...h});
  assert.deepEqual(h.calls.filter(x=>x.name==='package').map(x=>x.args.importSpecifier),['cache-modern','host-metadata','cache-old']);
  assert.equal(h.calls.filter(x=>x.name==='read')[1].args.files[0].path,'/scratch/project/node_modules/host-metadata/live.js');
});
test('locations beyond the default read window retain a nonempty range',async()=>{
  const h=harness(response('NODE compute() [src=src/large.ts loc=L800]'),{read:{files:[]}});
  await collectProbe({provider:'graphify',probe:{id:'long',family:'discovery',question:'Locate compute.',context:{}},workspace,...h});
  const range=h.calls.find(x=>x.name==='read').args.files[0];assert.ok(range.startLine>240);assert.ok(range.endLine>range.startLine);
});
test('raw omission markers remain intact and are called out',async()=>{
  const raw=Object.freeze({matches:[],omitted:true});const h=harness(response('No match'),{search:raw});
  const result=await collectProbe({provider:'graphify',probe:{id:'omitted',family:'negative',question:'Find missing.',context:{symbol:'missing'}},workspace,...h});
  assert.equal(result.evidence.at(-1).raw,raw);assert.match(result.limitations.join('\n'),/omissions/);
});
test('fallback reads start from the first actual match, not a later context row',async()=>{
  const h=harness(response('No matching nodes'),{search:{matches:[{file:'src/task.ts',line:10,text:'export function handler() {}',kind:'match'},{file:'src/task.ts',line:200,text:'later unrelated context',kind:'context'}]},read:{files:[]}});
  await collectProbe({provider:'graphify',probe:{id:'ambiguous',family:'ambiguity',question:'Locate handler.',context:{symbol:'handler'}},workspace,...h});
  assert.equal(h.calls.find(x=>x.name==='read').args.files[0].startLine,1);
});
