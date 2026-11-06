import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
const hash=value=>createHash('sha256').update(value).digest('hex')
const bytes=value=>Buffer.byteLength(value)
const inside=(root,file)=>{const value=relative(root,file);return value!=='..'&&!value.startsWith('../')&&!isAbsolute(value)}
function clip(text,limit){const value=Buffer.from(String(text));let end=Math.min(value.length,Math.max(0,limit));while(end>0&&end<value.length&&(value[end]&0xc0)===0x80)end--;return{text:value.subarray(0,end).toString(),omittedBytes:value.length-end}}
function small(value,limit=140){const original=typeof value==='string'?value:JSON.stringify(value??null),view=clip(original,limit);return view.text+(view.omittedBytes?' [omittedBytes='+view.omittedBytes+' sha256='+hash(original)+']':'')}
export const modelBytes=text=>bytes(JSON.stringify({text}))

const MAX_FILE_BYTES=1024*1024
const declaration=(ts,node)=>ts.isFunctionDeclaration(node)||ts.isMethodDeclaration(node)||ts.isClassDeclaration(node)||(ts.isVariableStatement(node)&&(ts.isSourceFile(node.parent)||ts.isModuleBlock(node.parent)||node.declarationList.declarations.some(value=>value.initializer&&(ts.isArrowFunction(value.initializer)||ts.isFunctionExpression(value.initializer)))))||ts.isInterfaceDeclaration(node)||ts.isTypeAliasDeclaration(node)||ts.isEnumDeclaration(node)||ts.isModuleDeclaration(node)||ts.isExportAssignment(node)

export async function projectSourceEvidence(search,workspaceRoot,{byteLimit=8192,typescript:ts,readSource=readFile,signal}={}){
 if(![4096,8192,12288].includes(byteLimit))throw Error('Unsupported fixed model byte limit')
 if(!ts?.createSourceFile)throw Error('The frozen backend TypeScript parser is required')
 const started=performance.now(),coverage=search.coverage??{},source=search.sourceContext??{},checks=Object.entries(search.checks??{}),seen=new Map(),candidates=[],invalid=[]
 const allFiles=source.files??[],measurement={nativeFileReads:0,nativeBytesRead:0,nativeReadMs:0,parserVersion:ts.version}
 async function load(absolute,expected,phase){
  signal?.throwIfAborted()
  const t0=performance.now()
  try{
   const canonical=await realpath(absolute)
   if(!inside(workspaceRoot,canonical))throw Error('Source path escapes the fixed workspace')
   const info=await stat(canonical)
   if(!info.isFile()||info.size>MAX_FILE_BYTES)throw Error('Source file exceeds bounded native load or is not a regular file')
   const value=await readSource(canonical,{signal});measurement.nativeFileReads++;measurement.nativeBytesRead+=value.length
   if(value.length>MAX_FILE_BYTES)throw Error('Source file grew beyond bounded native load')
   const observed=hash(value)
   if(observed!==expected){const error=Error('Source changed between retrieval and '+phase+': '+relative(workspaceRoot,absolute));error.code='source-changed';error.expectedSha256=expected;error.observedSha256=observed;throw error}
   const text=value.toString('utf8')
   if(!Buffer.from(text,'utf8').equals(value))throw Error('Source is not losslessly decodable UTF8')
   return text
  }finally{measurement.nativeReadMs+=performance.now()-t0}
 }
 try{
 for(const file of allFiles){
  if(typeof file.source!=='string'||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)){invalid.push('invalid-source-record');continue}
  const absolute=resolve(workspaceRoot,file.source),name=relative(workspaceRoot,absolute)
  if(!inside(workspaceRoot,absolute)||bytes(name)>512){invalid.push('out-of-scope-or-overlong-path');continue}
  if(seen.has(absolute)){if(seen.get(absolute)!==file.sha256)throw Error('Source changed between duplicate retrieval records: '+name);continue}
  seen.set(absolute,file.sha256)
  const hits=(search.results??[]).filter(hit=>hit.origin==='workspace'&&resolve(workspaceRoot,hit.source)===absolute).sort((a,b)=>(b.score??0)-(a.score??0))
  const hit=hits[0],text=await load(absolute,file.sha256,'expansion read'),sf=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true)
  const starts=sf.getLineStarts(),anchorLine=Math.max(0,Math.min(starts.length-1,(hit?.line??file.startLine??1)-1)),anchor=starts[anchorLine]
  const range=(start,end,selection,declarationComplete=false)=>{
   const value=text.slice(start,end),first=sf.getLineAndCharacterOfPosition(start),last=sf.getLineAndCharacterOfPosition(Math.max(start,end-1))
   return{path:name,rank:hit?.score??0,fileSha256:file.sha256,startLine:first.line+1,startColumn:first.character+1,endLine:last.line+1,endColumn:last.character+2,startOffset:start,endOffset:end,sourceComplete:start===0&&end===text.length,declarationComplete,selection,omittedBytes:bytes(text)-bytes(value),excerptSha256:hash(value),text:value}
  }
  const variants=[range(0,text.length,'complete-module')]
  if(!sf.parseDiagnostics.length){
   const declarations=[]
   const visit=node=>{if(node.getFullStart()<=anchor&&node.end>anchor){if(declaration(ts,node))declarations.push(node);ts.forEachChild(node,visit)}}
   ts.forEachChild(sf,visit)
   declarations.sort((a,b)=>(a.end-a.getFullStart())-(b.end-b.getFullStart()))
   for(const node of declarations){const first=sf.getLineAndCharacterOfPosition(node.getStart(sf)),last=sf.getLineAndCharacterOfPosition(Math.max(node.getStart(sf),node.end-1));variants.push(range(starts[first.line],starts[last.line+1]??text.length,'enclosing-declaration',true))}
  }
  const windowStart=starts[Math.max(0,anchorLine-3)];let windowEnd=starts[Math.min(starts.length-1,anchorLine+16)]??text.length
  while(bytes(text.slice(windowStart,windowEnd))>2000&&windowEnd>starts[anchorLine+1]){const line=sf.getLineAndCharacterOfPosition(windowEnd-1).line;windowEnd=starts[line]}
  if(windowEnd>windowStart)variants.push(range(windowStart,windowEnd,'partial-line-window'))
  candidates.push({absolute,fileSha256:file.sha256,rank:hit?.score??0,path:name,variants,parseDiagnostics:sf.parseDiagnostics.length,fullBytes:bytes(text)})
 }
 candidates.sort((a,b)=>b.rank-a.rank||a.path.localeCompare(b.path))
 const fixed=[
  'EXPERIMENTAL SOURCE EVIDENCE v2. Verbatim modules or enclosing declarations when budget permits; lexical candidates; not resolved definitions. Absence is unproven. Multiple candidates remain alternatives. APIs, compilation and tests are not run by this wrapper.',
  'STATUS '+small(search.status??'unknown',40)+' inventory='+(coverage.files===0?'empty':'observed')+' ambiguity=unresolved',
  'COVERAGE '+JSON.stringify({complete:coverage.complete??false,files:coverage.files??null,excluded:coverage.excludedCount??null,projects:(coverage.projects?.length??0)+(coverage.projectsOmitted??0),configs:(coverage.configs?.length??0)+(coverage.configsOmitted??0),issues:(coverage.issues?.length??0)+(coverage.issuesOmitted??0),dependencyErrors:coverage.dependencyErrors??null,missingIndexes:coverage.missingIndexes??null,exhaustive:coverage.retrieval?.exhaustive??false,candidateLimitReached:coverage.retrieval?.workspaceCandidateLimitReached??null}),
  'SEARCH CHECKS '+checks.slice(0,10).map(([name,value])=>small(name,40)+'='+small(value?.status??'unknown',24)+' ('+small(value?.reason??'',140)+')').join('; ')+' omittedChecks='+Math.max(0,checks.length-10),
  'ISSUES '+(coverage.issues??[]).slice(0,3).map(value=>small(value,160)).join('; ')+' omittedIssues='+((coverage.issuesOmitted??0)+Math.max(0,(coverage.issues?.length??0)-3)),
  'PROVENANCE searchSnapshot='+small(search.index?.snapshot??'unknown',100)+' fullResponseSha256='+hash(JSON.stringify(search))+' sourceImportResolution='+small(source.resolution??'not-run',40),
 ]
 const render=selected=>[...fixed,'OMISSIONS '+JSON.stringify({inputSourceFiles:allFiles.length,uniqueCandidates:candidates.length,returnedCandidates:selected.length,budgetCandidates:candidates.length-selected.length,duplicateSourceRecords:allFiles.length-candidates.length-invalid.length,invalidSourceRecords:invalid.length,upstreamSourceFilesOmitted:source.filesOmitted??0,unavailableImports:source.unavailableImports??0,ambiguousImports:source.ambiguousImports??0,syntaxErrorFiles:candidates.filter(value=>value.parseDiagnostics>0).length,sourceVerification:'full hashes checked at expansion and again before return; not an atomic snapshot',metadata:'project/config lists and duplicate envelopes omitted; complete response retained only in coordinator diagnostics'}),...selected.map((value,index)=>'CANDIDATE '+(index+1)+' '+JSON.stringify({path:value.path,lines:[value.startLine,value.endLine],columns:[value.startColumn,value.endColumn],offsets:[value.startOffset,value.endOffset],lexicalScore:value.rank,fileSha256:value.fileSha256,excerptSha256:value.excerptSha256,complete:value.sourceComplete,declarationComplete:value.declarationComplete,selection:value.selection,omittedBytes:value.omittedBytes})+'\n'+value.text)].join('\n\n')
 const selected=[]
 for(const candidate of candidates){for(const variant of candidate.variants){if(modelBytes(render([...selected,variant]))<=byteLimit){selected.push(variant);break}}}
 const text=render(selected)
 if(modelBytes(text)>byteLimit)throw Error('Metadata exceeds fixed byte limit; no evidence was silently dropped')
 for(const candidate of candidates)await load(candidate.absolute,candidate.fileSha256,'final verification')
 return{text,candidates:selected,measurement:{...measurement,rawResponseBytes:bytes(JSON.stringify(search)),availableSourceBytes:candidates.reduce((sum,file)=>sum+file.fullBytes,0),modelVisibleBytes:modelBytes(text),byteLimit,candidateCount:candidates.length,returnedCandidates:selected.length,sourceBytes:selected.reduce((sum,file)=>sum+bytes(file.text),0),projectionMs:performance.now()-started,apiCalls:0,compilerCalls:0,modelCalls:0,limitation:'Bytes are not model token savings; evidence may be omitted by the fixed budget.'}}
 }catch(error){error.measurement={...measurement,projectionMs:performance.now()-started};throw error}
}
