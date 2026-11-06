import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { extractPairedEvents } from './paired-agent-evidence.mjs'
import { extractToolOutputs } from './monorepo-tool-outputs.mjs'
const sha = x => createHash('sha256').update(x).digest('hex')
const mcp = { id: 'm1', type: 'mcp_tool_call', status: 'completed', server: 'fixture', tool: 'lookup', arguments: { file: '/Users/fixture/project/a.ts' }, result: { content: [{ type: 'text', text: 'source /Users/fixture/project/a.ts' }], structured_content: { answer: 7, message: 'tool message' }, custom: { retained: true } }, error: null }
const command = { id: 'c1', type: 'command_execution', status: 'completed', command: 'check', aggregated_output: 'failed check in /Users/fixture/project/a.ts', exit_code: 1 }
const fixture = (items = [mcp, command]) => {
  const raw = [{type:'turn.started'}, {type:'item.completed',item:{id:'private-r',type:'reasoning',text:'REASONING_SENTINEL'}}, {type:'item.completed',item:{id:'private-a',type:'agent_message',text:'MESSAGE_SENTINEL'}}, ...items.map(item=>({type:'item.completed',item})), {type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}].map(x=>JSON.stringify(x)).join('\n')+'\n'
  const record = {run:{id:'test-run',rawSha256:sha(raw)},actions:extractPairedEvents(raw).actions}
  const publicRecordBytes = JSON.stringify(record)
  return { raw, publicRecordBytes, expectedPublicRecordSha256:sha(publicRecordBytes), replacements:[['/Users/fixture/project','$WORKSPACE'],['/Users/fixture','$USER_HOME']] }
}
test('only completed allowlisted outputs export, with full MCP fields and normalized stdout',()=>{
 const input=fixture(); const out=extractToolOutputs(input), text=JSON.stringify(out)
 assert.equal(out.actions.length,2); assert(!text.includes('REASONING_SENTINEL')); assert(!text.includes('MESSAGE_SENTINEL')); assert(!text.includes('/Users/fixture'))
 assert.deepEqual(out.actions[0].result.custom,{retained:true}); assert.equal(out.actions[0].result.structured_content.message,'tool message')
 assert.equal(out.actions[1].stdout,'failed check in $WORKSPACE/a.ts'); assert.equal(out.actions[1].exitCode,1)
 assert.equal(out.actions[0].resultSha256,sha(JSON.stringify(mcp.result))); assert.equal(out.rawCaptureSha256,sha(input.raw))
})
test('rejects capture, public artifact and result hash mismatch before normalization',()=>{
 const a=fixture(); assert.throws(()=>extractToolOutputs({...a,raw:a.raw+' '}),/capture hash/)
 assert.throws(()=>extractToolOutputs({...a,expectedPublicRecordSha256:'0'.repeat(64)}),/public record hash/)
 const record=JSON.parse(a.publicRecordBytes);record.actions[0].resultSha256='0'.repeat(64);const bytes=JSON.stringify(record)
 assert.throws(()=>extractToolOutputs({...a,publicRecordBytes:bytes,expectedPublicRecordSha256:sha(bytes)}),/result hash/)
})
test('preserves failed MCP errors without exporting unrelated item properties',()=>{
 const item={...mcp,status:'failed',result:null,error:{code:'E_TOOL',message:'missing /Users/fixture/project/a.ts'},hidden:'UNRELATED_SENTINEL'}
 const out=extractToolOutputs(fixture([item]));assert.equal(out.actions[0].error.message,'missing $WORKSPACE/a.ts');assert.equal(out.actions[0].errorSha256,sha(JSON.stringify(item.error)));assert(!JSON.stringify(out).includes('UNRELATED_SENTINEL'))
})
test('rejects unbound actions, conflicting duplicates, missing output and uncovered private paths',()=>{
 const a=fixture();const record=JSON.parse(a.publicRecordBytes);record.actions.pop();const bytes=JSON.stringify(record)
 assert.throws(()=>extractToolOutputs({...a,publicRecordBytes:bytes,expectedPublicRecordSha256:sha(bytes)}),/unbound/)
 assert.throws(()=>extractToolOutputs(fixture([mcp,{...mcp,result:{different:true}}])),/duplicate|result hash/)
 assert.throws(()=>extractToolOutputs({...fixture(),replacements:[]}),/private path/)
 const r=JSON.parse(a.publicRecordBytes);r.actions[1].outputSha256='0'.repeat(64);const rb=JSON.stringify(r)
 assert.throws(()=>extractToolOutputs({...a,publicRecordBytes:rb,expectedPublicRecordSha256:sha(rb)}),/output hash/)
})
test('deduplicates identical completed events and excludes started events',()=>{
 const a=fixture([mcp,mcp]);const out=extractToolOutputs(a);assert.equal(out.actions.length,1);assert.equal(out.identicalCompletedDuplicates,1)
 const b=fixture([command]);b.raw=JSON.stringify({type:'item.started',item:mcp})+'\n'+b.raw;const record=JSON.parse(b.publicRecordBytes);record.run.rawSha256=sha(b.raw);b.publicRecordBytes=JSON.stringify(record);b.expectedPublicRecordSha256=sha(b.publicRecordBytes);assert.equal(extractToolOutputs(b).actions.length,1)
})
