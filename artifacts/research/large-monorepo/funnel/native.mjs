import { spawn } from 'node:child_process'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { minimatch } from 'minimatch'

const hash=x=>createHash('sha256').update(x).digest('hex')
const skip=new Set(['node_modules','.git','.codegraph','.serena','.typelatch'])
export async function createNative(workspace,charge=async(_name,_args,fn)=>fn()) {
 workspace=await realpath(workspace)
 const require=createRequire(join(workspace,'package.json')),ts=require('typescript')
 const inside=path=>{const p=resolve(workspace,path),r=relative(workspace,p);if(r==='..'||r.startsWith('../')||isAbsolute(r))throw Error('Path outside corpus');return p}
 const checked=async path=>{const p=await realpath(inside(path));inside(p);return p}
 const rel=path=>relative(workspace,path)
 async function walk(dir,accept,out=[]) {for(const e of await readdir(dir,{withFileTypes:true})){if(skip.has(e.name))continue;const p=join(dir,e.name);if(e.isDirectory())await walk(p,accept,out);else if(e.isFile()&&accept(e.name))out.push(p)}return out}
 async function snippet(path,startLine=1,endLine=240,maxBytes=18000) {
  path=await checked(path);const raw=await readFile(path),lines=raw.toString().split('\n'),selected=lines.slice(startLine-1,endLine).join('\n');let text=selected
  if(Buffer.byteLength(text)>maxBytes)text=Buffer.from(text).subarray(0,maxBytes).toString()
  return {path:rel(path),sha256:hash(raw),startLine,endLine:Math.min(endLine,lines.length),totalLines:lines.length,text,omitted:startLine>1||endLine<lines.length||text!==selected}
 }
 const core={
 async search({pattern,directories=['.'],glob=['**/src/**/*.{ts,tsx,js,mjs,cjs}','!**/*.d.ts','!**/{test,tests,__tests__,fixtures,__fixtures__}/**'],fixed=false,contextLines=0}) {
  const args=['--json','--no-ignore','--glob','!**/node_modules/**','--glob','!**/.git/**'];
  // Explicit dependency directories are permitted for installed declaration inspection.
  if(directories.some(p=>p.includes('node_modules')))args.splice(2,2)
  for(const g of Array.isArray(glob)?glob:[glob])args.push('--glob',g)
  if(fixed)args.push('--fixed-strings');if(contextLines)args.push('--context',String(contextLines))
  args.push('--',pattern,...directories.map(inside))
  const started=performance.now();const p=spawn('rg',args,{cwd:workspace,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',v=>stdout+=v);p.stderr.on('data',v=>stderr+=v)
  const timer=setTimeout(()=>p.kill('SIGKILL'),30000);const exitCode=await new Promise((ok,no)=>{p.on('error',no);p.on('close',ok)});clearTimeout(timer)
  if(![0,1].includes(exitCode))throw Error('rg failed: '+stderr)
  const all=stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>['match','context'].includes(x.type)).map(x=>({file:rel(x.data.path.text),line:x.data.line_number,text:x.data.lines.text.replace(/\n$/,''),kind:x.type}))
  return {matches:all.slice(0,180),matchCount:all.filter(x=>x.kind==='match').length,omitted:all.length>180,scope:{directories,glob},command:['rg',...args],processMs:performance.now()-started}
 },
 async read({files}) {return {files:await Promise.all(files.map(f=>snippet(f.path,f.startLine??1,f.endLine??240))) }},
 async configs({files}) {
  const paths=await walk(workspace,n=>/^tsconfig.*\.json$/.test(n));const rows=[]
  for(const file of files){const absolute=await checked(file),candidates=[]
   for(const path of paths){const config=ts.readConfigFile(path,ts.sys.readFile);const parsed=ts.parseJsonConfigFileContent(config.config??{},ts.sys,dirname(path));const ownsFile=parsed.fileNames.includes(absolute)
    if(ownsFile){const text=await readFile(path,'utf8');candidates.push({path:rel(path),text,ownsFile:true,compilerOptions:parsed.options,projectReferences:(parsed.projectReferences??[]).map(r=>rel(r.path)),parseErrors:parsed.errors.map(x=>ts.flattenDiagnosticMessageText(x.messageText,'\n'))})}
   }rows.push({file,configs:candidates})
  }return {files:rows,scannedConfigs:paths.length,compilerVersion:ts.version}
 },
 async package({file,importSpecifier,includeDeclarations=true}) {
  const absolute=await checked(file),configPath=ts.findConfigFile(dirname(absolute),ts.sys.fileExists),raw=configPath?ts.readConfigFile(configPath,ts.sys.readFile):{config:{}}
  const parsed=ts.parseJsonConfigFileContent(raw.config??{},ts.sys,configPath?dirname(configPath):workspace)
  const resolution=ts.resolveModuleName(importSpecifier,absolute,{...parsed.options,moduleResolution:parsed.options.moduleResolution??ts.ModuleResolutionKind.NodeJs},ts.sys).resolvedModule
  let runtimePath=null,runtimeError=null;try{runtimePath=createRequire(absolute).resolve(importSpecifier)}catch(e){runtimeError=e.code}
  const target=resolution?.resolvedFileName??runtimePath;if(!target)return {file,importSpecifier,resolution:null,runtimeError,package:null}
  const resolvedTarget=await checked(target),runtimeTarget=runtimePath?await checked(runtimePath):null;let p=dirname(runtimeTarget??resolvedTarget),manifest=null,manifestPath
  while(p!==dirname(p)){try{const value=JSON.parse(await readFile(join(p,'package.json'),'utf8'));if(value.name){manifest=value;manifestPath=join(p,'package.json');break}}catch{}p=dirname(p)}
  if(manifestPath)inside(manifestPath)
  return {file,importSpecifier,compilerVersion:ts.version,config:configPath?rel(configPath):null,resolution:resolution?{...resolution,resolvedFileName:rel(resolution.resolvedFileName)}:null,runtimePath:runtimePath?rel(runtimePath):null,runtimeError,
   package:manifest?{name:manifest.name,version:manifest.version,path:rel(manifestPath),realPath:rel(p),identitySource:runtimeTarget?'runtime-resolution':'declaration-resolution-only',type:manifest.type,main:manifest.main,types:manifest.types??manifest.typings,exports:manifest.exports,dependencies:manifest.dependencies}:null,
   declarations:includeDeclarations?[await snippet(resolvedTarget,1,300,22000)]:[]}
 },
 async manifests({packageName}) {
  const allPaths=await walk(workspace,n=>n==='package.json'),matches=[]
  const configPath=join(workspace,'pnpm-workspace.yaml'),configText=await readFile(configPath,'utf8'),patterns=parse(configText).packages
  if(!Array.isArray(patterns))throw Error('Missing explicit pnpm workspace patterns')
  const paths=allPaths.filter(path=>{const dir=rel(dirname(path));return dir===''||(patterns.filter(p=>!p.startsWith('!')).some(p=>minimatch(dir,p,{dot:true}))&&!patterns.filter(p=>p.startsWith('!')).some(p=>minimatch(dir,p.slice(1),{dot:true})))})
  for(const path of paths){const value=JSON.parse(await readFile(path,'utf8'));const relationships=['dependencies','optionalDependencies','peerDependencies'].filter(k=>value[k]?.[packageName]).map(kind=>({kind,range:value[kind][packageName]}));if(relationships.length)matches.push({path:rel(path),name:value.name,relationships})}
  return {matches,scannedManifestCount:paths.length,scope:'declared pnpm workspaces and root',workspaceDefinition:{path:rel(configPath),text:configText,sha256:hash(configText)}}
 }
 }
 return Object.fromEntries(Object.entries(core).map(([name,fn])=>[name,args=>charge('native.'+name,args,()=>fn(args))]))
}

export async function collectNative({probe,native}) {
 const c=probe.context
 if(probe.family==='ownership')return native.configs({files:c.files})
 if(c.importSpecifier&&c.file)return native.package({file:c.file,importSpecifier:c.importSpecifier})
 if(c.packageName)return native.manifests({packageName:c.packageName})
 if(probe.family==='installed-api'){
  const sources=await native.read({files:c.files.map(path=>({path,endLine:90}))});const packages=[]
  for(const f of sources.files){const imports=[...f.text.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)].map(m=>m[1]);const relevant=imports.filter(x=>/cache|hosted.git.info/.test(x));for(const importSpecifier of relevant){
   const pkg=await native.package({file:f.path,importSpecifier});packages.push(pkg)
   if(/hosted.git.info/.test(pkg.package?.name??'')){
    const entry=pkg.runtimePath??pkg.resolution?.resolvedFileName
    if(entry){const runtime=await native.read({files:[{path:entry,endLine:110}]});const text=runtime.files[0]?.text??'';const imported=[...text.matchAll(/(?:from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m=>m[1]).find(x=>/cache/.test(x))
     if(imported){const transitive=await native.package({file:entry,importSpecifier:imported});packages.push(transitive);const target=transitive.runtimePath??transitive.resolution?.resolvedFileName;if(target)await native.search({pattern:'module\\.exports|exports\\.LRUCache|maxAge|ttl|class LRUCache',directories:[target],glob:'*',contextLines:1})}
    }
   } else {const decl=pkg.declarations?.[0]?.path??pkg.resolution?.resolvedFileName;if(decl)await native.search({pattern:'export declare class LRUCache|constructor\\(|ttl\\??:',directories:[decl],glob:'*',contextLines:1})}
  }}return {sources,packages}
 }
 let pattern=c.symbol??c.importSpecifier??(probe.family==='freshness'?'workspaceConcurrency|availableParallelism':probe.family==='scope'?'excludeSelf|includeDependencies|includeDependents|parentDir':'installable|findWorkspace')
 if(probe.id==='direct-workspace-imports')pattern=c.importSpecifier
 const found=await native.search({pattern,directories:c.directories??['.'],fixed:!!(c.symbol||c.importSpecifier),contextLines:2})
 if(probe.family==='negative')return found
 const files=[...new Set(found.matches.filter(x=>x.kind==='match').map(x=>x.file))].slice(0,probe.family==='ambiguity'?2:4)
 if(!files.length)return found
 return {found,source:await native.read({files:files.map(path=>{const first=found.matches.find(x=>x.file===path&&x.kind==='match');const startLine=Math.max(1,(first?.line??1)-20);return {path,startLine,endLine:startLine+220}})})}
}
