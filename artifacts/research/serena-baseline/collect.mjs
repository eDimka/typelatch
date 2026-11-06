import { isAbsolute, relative } from 'node:path'
const replSessions=new WeakMap()
const escapeRegex=value=>value.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&')
const production=file=>/(?:^|\/)src\//.test(file)&&!file.endsWith('.d.ts')&&!/(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/.test(file)
const textOf=result=>result?.structuredContent?.result??result?.content?.filter(row=>row.type==='text').map(row=>row.text).join('\n')??''
const pathIn=(workspace,file)=>isAbsolute(file)?relative(workspace,file):file
const inScope=(file,dirs)=>!dirs?.length||dirs.some(dir=>file===dir||file.startsWith(dir.replace(/\/$/,'')+'/'))

function recipe(probe){
 if(probe.id==='discovery-workspace-scan')return{pattern:'[Ii]nstallable',limit:5,lines:220}
 if(probe.id==='scoped-selector-parser')return{pattern:'[Ss]elector',limit:5,lines:220,preferParser:true}
 if(probe.id==='direct-workspace-imports')return{pattern:escapeRegex(probe.context.importSpecifier),limit:20,lines:35,imports:true}
 if(probe.id==='freshness-concurrency')return{pattern:'availableParallelism|workspaceConcurrency',limit:6,lines:160}
 if(probe.context?.symbol)return{pattern:'\\b'+escapeRegex(probe.context.symbol)+'\\b',symbol:probe.context.symbol,limit:probe.family==='ambiguity'?4:8,lines:80}
 return null
}

export async function collectProbe({provider,probe,session,workspace,native,budget}){
 const limitations=[],notes=[]
 const isSerena=provider==='serena'||String(session.id).startsWith('serena')
 const call=(name,args)=>session.call(name,args,{timeoutMs:60000})
 const nativePackage=(file,importSpecifier)=>native.package({file,importSpecifier,includeDeclarations:true})
 if(probe.family==='ownership'){
  const response=await native.configs({files:probe.context.files})
  if(!isSerena){
   const requests=probe.context.files.flatMap(file=>[{command:'open',arguments:{file:workspace+'/'+file,projectRootPath:workspace}},{command:'projectInfo',arguments:{file:workspace+'/'+file,needFileNameList:false}}])
   await call('tsserver_batch',{requests})
  }
  notes.push('Owning configuration content is supplied by the common native helper; direct tsserver additionally reports its own chosen configured project.')
  return{limitations,notes}
 }
 if(probe.id==='declared-dependent-impact'){
  await native.manifests({packageName:probe.context.packageName})
  notes.push('Declarative direct relationships use common manifest inspection. No symbolic provider is forced to repeat this read.')
  return{limitations,notes}
 }
 if(probe.family==='installed-api'&&probe.context.file&&probe.context.importSpecifier){
  await nativePackage(probe.context.file,probe.context.importSpecifier)
  notes.push('Exact installed identity and declaration evidence use the common native package resolution helper; no extra symbolic request is required for the supplied import.')
  return{limitations,notes}
 }
 if(probe.id==='transitive-cache-api'){
  const files=await native.read({files:probe.context.files.map(path=>({path,startLine:1,endLine:90}))})
  const imports=[]
  for(const file of files.files??[]){
   const matches=[...file.text.matchAll(/(?:from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)]
   for(const match of matches){if(/(?:^|[\/-])(?:cache|hosted-git-info)(?:$|[\/-])/.test(match[1]))imports.push({file:file.path,importSpecifier:match[1]})}
  }
  const selected=imports.slice(0,2)
  if(imports.length>2)limitations.push('More than two relevant dependency edges were found; additional edges omitted by this collector budget.')
  for(const item of selected){
   const resolved=await nativePackage(item.file,item.importSpecifier)
   if(!item.importSpecifier.includes('hosted-git-info')){
    const declaration=resolved.declarations?.[0]?.path??resolved.resolution?.resolvedFileName
    if(declaration)await native.search({pattern:'export declare class LRUCache|constructor\\(|ttl\\??:',directories:[declaration],glob:'*',contextLines:1})
   }
   if(item.importSpecifier.includes('hosted-git-info')){
    const entry=resolved.runtimePath??resolved.resolution?.resolvedFileName
    if(!entry){limitations.push('The actual hosted package entry was unresolved; transitive inspection stopped.');continue}
    const read=await native.read({files:[{path:entry,startLine:1,endLine:110}]})
    const entryText=read.files?.[0]?.text??''
    const dependency=[...entryText.matchAll(/(?:from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(match=>match[1]).find(name=>name.includes('cache'))
    if(!dependency){limitations.push('No cache import was observed in the resolved hosted package entry slice.');continue}
    const transitive=await nativePackage(entry,dependency)
    const runtime=transitive.runtimePath??transitive.resolution?.resolvedFileName
    if(runtime)await native.search({pattern:'module\\.exports|exports\\.LRUCache|maxAge|ttl|class LRUCache',directories:[runtime],glob:'*',contextLines:1})
   }
  }
  notes.push('Transitive paths are followed only from returned installed entry content. No lockfile-only version is substituted for a live import edge.')
  return{limitations,notes}
 }
 const plan=recipe(probe)
 if(!plan)throw Error('No public-input collector for '+probe.id)
 const directories=probe.context?.directories??[]
 if(isSerena){
  const sessionKey=session.setupRecord??session
  let sessionId=replSessions.get(sessionKey)
  if(!sessionId){const initial=await call('initial_instructions',{});sessionId=textOf(initial).match(/session id is .([a-f0-9]+)./)?.[1];if(!sessionId)throw Error('Serena did not provide a session id');replSessions.set(sessionKey,sessionId)}
  const symbol=plan.symbol?JSON.stringify(plan.symbol):'None'
  const code=[
   'import os, json',
   'pattern = '+JSON.stringify(plan.pattern),
   'scope = '+JSON.stringify(directories),
   'root = '+JSON.stringify(workspace),
   'hits = []',
   'for directory in (scope or ["."]):',
   '    found = s.fs.search_for_pattern(pattern, relative_path=directory, paths_include_glob="**/src/**/*.ts", context_lines_before=2, context_lines_after=2, max_answer_chars=16000)',
   '    hits.extend(found.matches)',
   'paths = []',
   'first_line = {}',
   'for match in hits:',
   '    value = match.source_file_path',
   '    value = os.path.relpath(value, root) if os.path.isabs(value) else value',
   '    if (value.startswith("src/") or "/src/" in value) and not value.endswith(".d.ts") and not any(part in ("test", "tests", "__tests__", "fixtures") for part in value.split("/")) and value not in paths:',
   '        paths.append(value)',
   '        first_line[value] = match.matched_lines[0].line_number',
   plan.preferParser?'paths.sort(key=lambda value: ("pars" not in value.lower(), value))':'paths.sort()',
   'selected = paths[:'+plan.limit+']',
   'evidence = []',
   'for path in selected:',
   plan.imports?'    start = max(0, first_line[path] - 12)':'    start = max(0, first_line[path] - 30)',
   '    content = s.fs.read_file(path, start_line=start, end_line=start+'+plan.lines+', max_answer_chars=20000)',
   '    evidence.append({"path": path, "startLine": start, "source": content.text, "returnedLines": len(content.lines)})',
   'symbol = '+symbol,
   'symbols = []',
   'if symbol is not None:',
   '    for path in selected:',
   '        symbols.append(s.lsp.find_symbol(symbol, relative_path=path, include_body=True, max_matches=-1, max_answer_chars=14000))',
   '({"scope": scope or ["repository production source"], "matchedFileCount": len(paths), "returnedFileCount": len(selected), "omittedFiles": len(paths)-len(selected), "sourceLineLimit": '+plan.lines+', "evidence": evidence}, symbols)',
  ].join('\n')
  const response=await call('serena_repl',{session:sessionId,code})
  if(!response.isError){notes.push('Serena combined scoped pattern discovery, bounded source reads and any exact symbol lookup in one REPL call. Output includes its own omissions; absence remains scoped.');return{limitations,notes}}
  limitations.push('Serena REPL reported an error; common native fallback is used and charged. '+textOf(response).slice(0,300))
 }
 const found=await native.search({pattern:plan.pattern,...(directories.length?{directories}:{}),glob:'**/src/**/*.ts',contextLines:plan.imports?8:2})
 const matches=(found.matches??[]).filter(row=>(!row.kind||row.kind==='match')&&production(pathIn(workspace,row.file))&&inScope(pathIn(workspace,row.file),directories))
 const unique=new Map()
 for(const row of matches){const file=pathIn(workspace,row.file);if(!unique.has(file))unique.set(file,row)}
 let targets=[...unique.keys()].sort()
 if(plan.preferParser)targets.sort((a,b)=>Number(!a.toLowerCase().includes('pars'))-Number(!b.toLowerCase().includes('pars'))||a.localeCompare(b))
 if(targets.length>plan.limit)limitations.push((targets.length-plan.limit)+' matched source files omitted from bounded follow-up. Do not treat returned definitions as exhaustive.')
 targets=targets.slice(0,plan.limit)
 if(!targets.length){notes.push('No exact pattern occurrence was returned within the requested production-source scope. This does not assert anything about other scopes or unsupported files.');return{limitations,notes}}
 if(!isSerena&&!plan.imports){
  const requests=targets.slice(0,6).flatMap(file=>{
   const hit=unique.get(file),match=hit.text.match(new RegExp(plan.pattern)),position={file:workspace+'/'+file,line:hit.line,offset:(match?.index??0)+1}
   return [{command:'open',arguments:{file:workspace+'/'+file,projectRootPath:workspace}},{command:'quickinfo',arguments:position},{command:'definitionAndBoundSpan',arguments:position}]
  })
  await call('tsserver_batch',{requests})
 }
 await native.read({files:targets.map(path=>{
  const hit=unique.get(path);const startLine=Math.max(1,(hit?.line??1)-(plan.imports?12:30))
  return{path,startLine,endLine:startLine+plan.lines}
 })})
 notes.push('Source targets and positions derive only from charged search responses. Native TypeScript batches targeted hover and definition requests; native source reads retain implementation evidence.')
 return{limitations,notes}
}
