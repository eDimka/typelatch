import assert from 'node:assert/strict'
import test from 'node:test'
import { collectProbe } from './collect.mjs'
test('targeted TypeScript requests use the match rather than adjacent context',async()=>{
 const calls=[];await collectProbe({provider:'typescript',workspace:'/scratch',probe:{id:'freshness-concurrency',family:'freshness',context:{}},
  session:{call:async(name,args)=>{calls.push({name,args});return {structuredContent:{}}}},
  native:{search:async()=>({matches:[{file:'src/main.ts',line:10,text:'// preceding context',kind:'context'},{file:'src/main.ts',line:12,text:'const n = availableParallelism()',kind:'match'}]}),read:async()=>({files:[]})}})
 assert.deepEqual(calls[0].args.requests.map(x=>x.command),['open','quickinfo','definitionAndBoundSpan'])
 assert.equal(calls[0].args.requests[1].arguments.line,12);assert.equal(calls[0].args.requests[1].arguments.offset,11)
})
