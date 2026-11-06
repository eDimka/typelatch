import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),started=performance.now()
const hash=value=>createHash('sha256').update(value).digest('hex')
const protectedFiles=['providers.mjs','collect.mjs','runtime-manifest.json','collect-qualified.json','qualification-freeze.json','README.md','QUALIFICATION.md']
const before=Object.fromEntries(await Promise.all(protectedFiles.map(async file=>[file,hash(await readFile(join(here,file)))])))
const python=JSON.parse(execFileSync(join(here,'venv/bin/python'),['-c','import sys,sysconfig,json; print(json.dumps({"executable":sys.executable,"baseExecutable":getattr(sys,"_base_executable",None),"basePrefix":sys.base_prefix,"stdlib":sysconfig.get_path("stdlib"),"version":sys.version}))'],{encoding:'utf8'}))
const excludedDirectories=new Set(['.git','__pycache__','.cache','.pytest_cache','.mypy_cache','.ruff_cache'])
const roots=[
 {id:'venv',path:join(here,'venv')},
 {id:'serena-source',path:join(here,'source')},
 {id:'language-server-node-modules',path:join(here,'ls-runtime/node_modules')},
 {id:'base-python-standard-library',path:await realpath(python.stdlib),excludeSitePackages:true}
]
const entries=[],skipped=[],jobs=[]
async function visit(root,dir){
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(dir,entry.name),rel=relative(root.path,path)
  if(entry.isDirectory()&&(excludedDirectories.has(entry.name)||(root.excludeSitePackages&&rel==='site-packages'))){skipped.push({root:root.id,path:rel,reason:'Declared generated/cache or external site-packages boundary'});continue}
  if(entry.name.endsWith('.pyc')||entry.name.endsWith('.pyo')){skipped.push({root:root.id,path:rel,reason:'Generated Python bytecode'});continue}
  if(entry.isSymbolicLink()){entries.push({root:root.id,path:rel,kind:'symlink',target:await readlink(path)});continue}
  if(entry.isDirectory()){await visit(root,path);continue}
  if(entry.isFile()){jobs.push(async()=>{const bytes=await readFile(path),info=await stat(path);entries.push({root:root.id,path:rel,kind:'file',bytes:bytes.length,mode:info.mode&0o777,sha256:hash(bytes)})});continue}
  throw Error('Unfingerprinted special file '+path)
 }
}
for(const root of roots)await visit(root,root.path)
let next=0
await Promise.all(Array.from({length:12},async()=>{while(next<jobs.length){const job=jobs[next++];await job()}}))
entries.sort((a,b)=>a.root.localeCompare(b.root)||a.path.localeCompare(b.path))
skipped.sort((a,b)=>a.root.localeCompare(b.root)||a.path.localeCompare(b.path))
const executablePaths=[{id:'base-python-executable',path:python.baseExecutable},{id:'base-python-framework-library',path:join(python.basePrefix,'Python')},{id:'node-executable',path:process.execPath}]
const executables=[]
for(const target of executablePaths){const resolved=await realpath(target.path),bytes=await readFile(resolved);executables.push({...target,realPath:resolved,bytes:bytes.length,sha256:hash(bytes)})}
for(const file of protectedFiles)assert.equal(hash(await readFile(join(here,file))),before[file],'Existing frozen file changed '+file)
const manifest={schemaVersion:1,createdAt:new Date().toISOString(),kind:'complete-files-within-declared-runtime-boundaries',elapsedMs:performance.now()-started,roots,python,nodeVersion:process.version,exclusions:{directoryNames:[...excludedDirectories],fileExtensions:['.pyc','.pyo'],basePythonStdlibSitePackages:true,symlinks:'Record target text without recursively following links. Base Python binary, framework library and standard library are separately hashed.',outsideBoundary:'Operating system libraries and transitive Homebrew dynamic libraries are not included. Shared orchestrator dependencies outside the named roots are owned by its separate freeze.'},summary:{regularFiles:entries.filter(x=>x.kind==='file').length,symlinks:entries.filter(x=>x.kind==='symlink').length,fileBytes:entries.reduce((sum,x)=>sum+(x.bytes??0),0),excludedEntries:skipped.length},contentSha256:hash(JSON.stringify(entries)),executables,protectedFiles:Object.entries(before).map(([path,sha256])=>({path,sha256})),entries,skipped}
await writeFile(join(here,'runtime-full-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({file:'runtime-full-manifest.json',sha256:hash(await readFile(join(here,'runtime-full-manifest.json'))),summary:manifest.summary,elapsedMs:manifest.elapsedMs,protectedFilesUnchanged:true},null,2))
