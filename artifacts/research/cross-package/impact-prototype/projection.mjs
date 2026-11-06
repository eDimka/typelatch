import assert from 'node:assert/strict'
import {writeFileSync,realpathSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
const fields=['direct','packageDependents','validationTargets','excluded','lookalikes','issues']
const sha=value=>createHash('sha256').update(value).digest('hex')
export function projectResponse(packet,{workspaceRoot,outputFile,maxBytes=30000}={}) {
 assert(Number.isInteger(maxBytes)&&maxBytes>=2000&&maxBytes<=60000)
 const result=structuredClone(packet)
 result.totals=Object.fromEntries(fields.map(key=>[key,result[key]?.length??0]))
 result.omissions=Object.fromEntries(fields.map(key=>[key,0]))
 for(const row of result.direct??[]){row.occurrenceCount=row.occurrences?.length??0;delete row.occurrences}
 if(outputFile!==undefined){
  assert(workspaceRoot&&typeof outputFile==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(outputFile),'Output must be a new JSON file in the fixed workspace root')
  const bytes=JSON.stringify(packet,null,2)+'\n';assert(Buffer.byteLength(bytes)<=2*1024*1024,'Full report exceeds 2 MiB')
  const path=join(realpathSync(workspaceRoot),outputFile)
  writeFileSync(path,bytes,{flag:'wx',mode:0o600})
  result.artifact={path:outputFile,sha256:sha(bytes),bytes:Buffer.byteLength(bytes),allCollectedFactsSaved:true,meaning:'Full evidence JSON. This is not a task-specific final answer. Transform its fields to the requested report format and inspect explicit limits.'}
  for(const field of fields){const full=result[field]??[];result[field]=full.slice(0,3);result.omissions[field]=full.length-result[field].length}
 }
 while(Buffer.byteLength(JSON.stringify(result))>maxBytes){
  const field=fields.filter(key=>result[key]?.length).sort((a,b)=>JSON.stringify(result[b]).length-JSON.stringify(result[a]).length)[0]
  if(!field)throw Error('Evidence metadata exceeds response budget')
  result[field].pop();result.omissions[field]++
 }
 if(!outputFile&&Object.values(result.omissions).some(value=>value>0))result.status='partial'
 result.responseScope=outputFile?'Full facts saved in artifact; response contains samples.':'Returned facts only; omissions are explicit.'
 // Leave headroom for the scope label without dropping omission metadata.
 while(Buffer.byteLength(JSON.stringify(result))>maxBytes){const field=fields.filter(key=>result[key]?.length).sort((a,b)=>JSON.stringify(result[b]).length-JSON.stringify(result[a]).length)[0];if(!field)throw Error('Evidence metadata exceeds response budget');result[field].pop();result.omissions[field]++;if(!outputFile)result.status='partial'}
 return result
}
