import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
const hash=value=>createHash('sha256').update(value).digest('hex')
const bytes=value=>Buffer.byteLength(value)
const inside=(root,file)=>{const value=relative(root,file);return value!=='..'&&!value.startsWith('../')&&!isAbsolute(value)}
function clip(text,limit){const value=Buffer.from(String(text));let end=Math.min(value.length,Math.max(0,limit));while(end>0&&end<value.length&&(value[end]&0xc0)===0x80)end--;return{text:value.subarray(0,end).toString(),omittedBytes:value.length-end}}
function small(value,limit=140){const original=typeof value==='string'?value:JSON.stringify(value??null),view=clip(original,limit);return view.text+(view.omittedBytes?' [omittedBytes='+view.omittedBytes+' sha256='+hash(original)+']':'')}
export const modelBytes=text=>bytes(JSON.stringify({text}))

/** Research view only: no compiler, model, filesystem read or inferred API facts. */
export function projectSourceEvidence(search,workspaceRoot,{byteLimit=8192}={}){
 if(![4096,8192,12288].includes(byteLimit))throw Error('Unsupported fixed model byte limit')
 const coverage=search.coverage??{},source=search.sourceContext??{},checks=Object.entries(search.checks??{}),seen=new Set(),candidates=[],invalid=[]
 const allFiles=source.files??[]
 for(const file of allFiles){
  if(typeof file.source!=='string'||typeof file.text!=='string'||typeof file.sha256!=='string'){invalid.push('invalid-source-record');continue}
  const absolute=resolve(workspaceRoot,file.source),name=relative(workspaceRoot,absolute)
  if(!inside(workspaceRoot,absolute)||bytes(name)>512){invalid.push('out-of-scope-or-overlong-path');continue}
  const key=absolute+'\0'+file.sha256+'\0'+file.startLine+'\0'+file.text
  if(seen.has(key))continue
  seen.add(key)
  const hits=(search.results??[]).filter(hit=>hit.origin==='workspace'&&resolve(workspaceRoot,hit.source)===absolute).sort((a,b)=>(b.score??0)-(a.score??0))
  const hit=hits[0],lines=file.text.split('\n'),baseLine=file.startLine??1
  const anchor=Math.max(0,Math.min(lines.length-1,(hit?.line??baseLine)-baseLine)),start=Math.max(0,anchor-8),end=Math.min(lines.length,anchor+61)
  const chosen=lines.slice(start,end).join('\n'),view=clip(chosen,2300)
  const omittedBytes=(file.omittedBytes??0)+bytes(file.text)-bytes(chosen)+view.omittedBytes
  candidates.push({path:name,rank:hit?.score??0,fileSha256:file.sha256,startLine:baseLine+start,startColumn:start===0?(file.startColumn??1):1,endLine:baseLine+start+view.text.split('\n').length-1,sourceComplete:!!file.complete&&start===0&&end===lines.length&&view.omittedBytes===0,omittedBytes,excerptSha256:hash(view.text),text:view.text})
 }
 candidates.sort((a,b)=>b.rank-a.rank||a.path.localeCompare(b.path)||a.startLine-b.startLine)
 const fixed=[
  'EXPERIMENTAL SOURCE EVIDENCE v1. Verbatim lexical candidates; not resolved definitions. Absence is unproven. Multiple candidates remain alternatives. APIs, compilation and tests are not run by this wrapper.',
  'STATUS '+small(search.status??'unknown',40)+' inventory='+(coverage.files===0?'empty':'observed')+' ambiguity=unresolved',
  'COVERAGE '+JSON.stringify({complete:coverage.complete??false,files:coverage.files??null,excluded:coverage.excludedCount??null,projects:(coverage.projects?.length??0)+(coverage.projectsOmitted??0),configs:(coverage.configs?.length??0)+(coverage.configsOmitted??0),issues:(coverage.issues?.length??0)+(coverage.issuesOmitted??0),dependencyErrors:coverage.dependencyErrors??null,missingIndexes:coverage.missingIndexes??null,exhaustive:coverage.retrieval?.exhaustive??false,candidateLimitReached:coverage.retrieval?.workspaceCandidateLimitReached??null}),
  'SEARCH CHECKS '+checks.slice(0,10).map(([name,value])=>small(name,40)+'='+small(value?.status??'unknown',24)+' ('+small(value?.reason??'',140)+')').join('; ')+' omittedChecks='+Math.max(0,checks.length-10),
  'ISSUES '+(coverage.issues??[]).slice(0,3).map(value=>small(value,160)).join('; ')+' omittedIssues='+((coverage.issuesOmitted??0)+Math.max(0,(coverage.issues?.length??0)-3)),
  'PROVENANCE searchSnapshot='+small(search.index?.snapshot??'unknown',100)+' fullResponseSha256='+hash(JSON.stringify(search))+' sourceImportResolution='+small(source.resolution??'not-run',40),
 ]
 const render=selected=>[...fixed,'OMISSIONS '+JSON.stringify({inputSourceFiles:allFiles.length,uniqueCandidates:candidates.length,returnedCandidates:selected.length,budgetCandidates:candidates.length-selected.length,duplicateSourceRecords:allFiles.length-candidates.length-invalid.length,invalidSourceRecords:invalid.length,upstreamSourceFilesOmitted:source.filesOmitted??0,unavailableImports:source.unavailableImports??0,ambiguousImports:source.ambiguousImports??0,metadata:'project/config lists and duplicate envelopes omitted; complete response retained only in coordinator diagnostics'}),...selected.map((value,index)=>'CANDIDATE '+(index+1)+' '+JSON.stringify({path:value.path,lines:[value.startLine,value.endLine],startColumn:value.startColumn,lexicalScore:value.rank,fileSha256:value.fileSha256,excerptSha256:value.excerptSha256,complete:value.sourceComplete,omittedBytes:value.omittedBytes})+'\n'+value.text)].join('\n\n')
 const selected=[]
 for(const candidate of candidates){if(modelBytes(render([...selected,candidate]))<=byteLimit)selected.push(candidate)}
 const text=render(selected)
 if(modelBytes(text)>byteLimit)throw Error('Metadata exceeds fixed byte limit; no evidence was silently dropped')
 return{text,candidates:selected,measurement:{rawResponseBytes:bytes(JSON.stringify(search)),availableSourceBytes:allFiles.reduce((sum,file)=>sum+bytes(file.text??''),0),modelVisibleBytes:modelBytes(text),byteLimit,candidateCount:candidates.length,returnedCandidates:selected.length,sourceBytes:selected.reduce((sum,file)=>sum+bytes(file.text),0),apiCalls:0,compilerCalls:0,modelCalls:0,limitation:'Bytes are not model token savings; evidence may be omitted by the fixed budget.'}}
}
