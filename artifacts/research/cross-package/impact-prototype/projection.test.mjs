import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {projectResponse} from './projection.mjs'
const packet=()=>({schemaVersion:1,status:'ok',target:{package:'@demo/api',version:'1.0.0',exports:['parse']},direct:Array.from({length:50},(_,i)=>({file:`packages/p${i}/src/index.ts`,symbol:'parse',role:'runtime',evidence:{startLine:1,endLine:1,quote:'import { parse } from "@demo/api"'},occurrences:[{line:2,text:'parse("ok")'}]})),packageDependents:[],validationTargets:[],excluded:[],lookalikes:[],uncertainties:[],issues:[],coverage:{configuredSourceFiles:50}})
test('bounded response retains omissions and exact quotes without duplicated transport payload',()=>{
 const result=projectResponse(packet(),{maxBytes:2200})
 assert(Buffer.byteLength(JSON.stringify(result))<=2200)
 assert(result.omissions.direct>0);assert.equal(result.totals.direct,50)
 assert.equal(result.status,'partial');assert.equal(result.direct[0].evidence.quote,'import { parse } from "@demo/api"')
})
test('optional report materializes exact facts once and rejects existing files and paths outside root',()=>{
 const root=mkdtempSync(join(tmpdir(),'typelatch-impact-output-'))
 try{
  const data=packet(),result=projectResponse(data,{workspaceRoot:root,outputFile:'evidence.json'})
  const saved=JSON.parse(readFileSync(join(root,'evidence.json')))
  assert.equal(saved.direct.length,50);assert.equal(result.artifact.path,'evidence.json');assert.equal(result.artifact.bytes,Buffer.byteLength(readFileSync(join(root,'evidence.json'))))
  assert(result.direct.length<=3);assert.equal(result.artifact.allCollectedFactsSaved,true)
  assert.throws(()=>projectResponse(data,{workspaceRoot:root,outputFile:'../escape.json'}))
  assert.throws(()=>projectResponse(data,{workspaceRoot:root,outputFile:'evidence.json'}))
  writeFileSync(join(root,'sentinel.json'),'keep')
  assert.throws(()=>projectResponse(data,{workspaceRoot:root,outputFile:'sentinel.json'}))
  assert.equal(readFileSync(join(root,'sentinel.json'),'utf8'),'keep')
 }finally{rmSync(root,{recursive:true,force:true})}
})
