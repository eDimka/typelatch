import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNative, collectNative } from './native.mjs'
const here=dirname(fileURLToPath(import.meta.url)),base=dirname(here),root=resolve(here,'../../../..')
const sha=x=>createHash('sha256').update(x).digest('hex'),json=x=>JSON.stringify(x,null,2)+'\n'
const exec=promisify(execFile)
const manifestBytes=await readFile(join(base,'probes-public.json')),protocol=JSON.parse(manifestBytes)
assert.equal(sha(manifestBytes),'299a395497c825251b7017b5af4fe3b2fc578b3695a73919e10fb08b6187280b')
const source=join(base,'pnpm-installed'),inventory=JSON.parse(await readFile(join(base,'corpus-inventory.json')))
const providers=['native','typelatch','typescript','serena','codegraph','graphify']
const schedules=[providers,[...providers].reverse(),[...providers.slice(1),providers[0]]]
const [operation,outputArgument,onlyProvider,roundArgument]=process.argv.slice(2),output=resolve(outputArgument??join(base,'screen-001'))
const rounds=roundArgument?[Number(roundArgument)]:[1,2,3]
await mkdir(output,{recursive:true})
async function sourceCheck(workspace) {let count=0,links=0;for(const entry of inventory.entries){if(entry.kind==='symlink'){assert.equal(await readlink(join(workspace,entry.path)),entry.target,'Changed source symlink '+entry.path);links++;continue}if(entry.kind!=='file')continue;assert.equal(sha(await readFile(join(workspace,entry.path))),entry.sha256,'Changed source '+entry.path);count++}return {verifiedSourceFiles:count,verifiedSourceLinks:links,sourceInventorySha256:sha(await readFile(join(base,'corpus-inventory.json')))}}
async function verifyLinks(workspace,dir=workspace,summary={symlinks:0,brokenSymlinks:[]}) {
 for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isSymbolicLink()){const target=await readlink(p);assert(!isAbsolute(target),'Absolute copied symlink '+p);const lexical=resolve(dirname(p),target),r=relative(workspace,lexical);assert(!(r==='..'||r.startsWith('../')),'Escaping copied symlink '+p);try{const actual=await realpath(p),ar=relative(workspace,actual);assert(!(ar==='..'||ar.startsWith('../')),'Escaping resolved symlink '+p)}catch(e){if(e.code==='ENOENT')summary.brokenSymlinks.push(relative(workspace,p));else throw e}summary.symlinks++}else if(e.isDirectory()&&e.name!=='.git')await verifyLinks(workspace,p,summary)}return summary
}
const paths=(round,provider)=>{const dir=join(output,`round-${round}`,provider);return {dir,workspace:join(dir,'workspace'),cacheRoot:join(dir,'state')}}
if(operation==='prepare') {
 for(const round of rounds)for(const provider of schedules[round-1]){if(onlyProvider&&provider!==onlyProvider)continue;const {dir,workspace}=paths(round,provider);await mkdir(dir,{recursive:true});await writeFile(join(dir,'preparation-started.json'),json({startedAt:new Date().toISOString(),source}),{flag:'wx'});try{await exec('/bin/cp',['-cR',source,workspace],{timeout:180000});const restoredSourceLinks=[];for(const entry of inventory.entries.filter(x=>x.kind==='symlink')){const path=join(workspace,entry.path),before=await readlink(path);if(before!==entry.target){await unlink(path);await symlink(entry.target,path);restoredSourceLinks.push({path:entry.path,before,after:entry.target,reason:'Restore exact committed relative symlink text altered by prior preparation copy'})}}await writeFile(join(dir,'prepared.json'),json({...await sourceCheck(workspace),...await verifyLinks(workspace),restoredSourceLinks}));console.log(json({prepared:provider,round}).trim())}catch(error){await writeFile(join(dir,'preparation-failed.json'),json({error:String(error)}));throw error}}
 process.exit(0)
}
if(operation!=='run')throw Error('Usage: run.mjs prepare|run OUTPUT [PROVIDER] [ROUND]')
const frozen=JSON.parse(await readFile(join(output,'frozen.json')))
for(const file of frozen.files)assert.equal(sha(await readFile(join(root,file.path))),file.sha256,'Frozen file changed '+file.path)
const mutation=JSON.parse(await readFile(join(base,'truth-private/expected.json'))).mutation
for(const round of rounds)for(const provider of schedules[round-1]) {
 if(onlyProvider&&provider!==onlyProvider)continue
 const {dir,workspace,cacheRoot}=paths(round,provider);await readFile(join(dir,'prepared.json'));await sourceCheck(workspace)
 const record={schemaVersion:1,provider,round,startedAt:new Date().toISOString(),protocolSha256:sha(manifestBytes),frozenSha256:sha(await readFile(join(output,'frozen.json'))),probes:[]}
 await writeFile(join(dir,'started.json'),json(record),{flag:'wx',mode:0o600})
 const persist=()=>writeFile(join(dir,'result.json'),json(record),{mode:0o600})
 let session,collect,originalMutationBytes,mutationFile,mutationStarted
 try {
  const start=performance.now()
  if(provider==='native'){session={setupRecord:{provider,elapsedMs:0},close:async()=>{}};collect=collectNative}
  else {
   const module=provider==='typelatch'?await import('./typelatch.mjs'):['serena','typescript'].includes(provider)?await import('../../serena-baseline/providers.mjs'):await import('../../competitors/adapter.mjs')
   session=await module.openProvider({provider,workspace,cacheRoot,mode:'cold'})
   const collector=provider==='typelatch'?await import('./typelatch.mjs'):['serena','typescript'].includes(provider)?await import('../../serena-baseline/collect.mjs'):await import('../../competitors/collect.mjs');collect=collector.collectProbe
  }
  record.setupWallMs=performance.now()-start;record.setup=session.setupRecord;record.schemas=session.schemas;await persist();if(record.setupWallMs>600000)throw Error('Cold setup deadline exceeded')
  console.log(json({provider,round,ready:true,setupMs:record.setupWallMs}).trim())
  async function probeRun(probe,phase='initial',absoluteDeadline=Infinity) {
   const row={id:probe.id,phase,startedAt:new Date().toISOString(),actions:[],status:'running'},t0=performance.now();record.probes.push(row);await persist()
   let bytes=0
   const charge=async(name,args,fn)=>{
    if(row.actions.length>=8||bytes>=65536)throw Error('Evidence budget exhausted')
    if(performance.now()>=Math.min(t0+60000,absoluteDeadline))throw Error('Probe deadline exhausted')
    const item={name,args,startedAt:new Date().toISOString()},s=performance.now();row.actions.push(item)
    try{const raw=await fn();item.raw=raw;const visible=raw?.structuredContent??(raw?.content?raw.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'):raw);item.textBytes=Buffer.byteLength(typeof visible==='string'?visible:JSON.stringify(visible));bytes+=item.textBytes;item.rawBytes=Buffer.byteLength(JSON.stringify(raw));if(bytes>65536)throw Error('Returned evidence exceeded cumulative byte budget');if(performance.now()>=Math.min(t0+60000,absoluteDeadline))throw Error('Probe deadline exceeded during completed action');return raw}
    catch(error){item.error=String(error);throw error}finally{item.elapsedMs=performance.now()-s;await persist()}
   }
   const native=await createNative(workspace,charge)
   const wrapped={...session,call:(name,args,opts={})=>charge(name,args,()=>session.call(name,args,{...opts,timeoutMs:Math.max(1,Math.min(t0+60000,absoluteDeadline)-performance.now())}))}
   try{row.collectorResult=await collect({provider,probe,session:wrapped,workspace,native,budget:{maxActions:8,maxTextBytes:65536}});row.status=row.actions.some(x=>x.error)?'failed':'completed'}catch(e){row.status='failed';row.error=String(e)}
   row.elapsedMs=performance.now()-t0;row.textBytes=bytes;row.actionCount=row.actions.length;await persist()
   console.log(json({provider,round,probe:probe.id,phase,status:row.status,actions:row.actionCount,textBytes:bytes,elapsedMs:row.elapsedMs,error:row.error}).trim())
   if(row.actions.some(x=>x.error&&/timeout|timed out/i.test(x.error)))throw Error('Timed out provider session is tainted')
   return row
  }
  for(const probe of protocol.questions)await probeRun(probe)
  const fresh=protocol.questions.find(x=>x.family==='freshness');await probeRun(fresh,'warm-1');await probeRun(fresh,'warm-2')
  mutationFile=join(workspace,mutation.path);originalMutationBytes=await readFile(mutationFile);assert.equal(sha(originalMutationBytes),mutation.beforeSha256)
  const changed=originalMutationBytes.toString().replace(mutation.needle,mutation.replacement);assert.equal(sha(changed),mutation.afterSha256);await writeFile(mutationFile,changed);mutationStarted=performance.now()
  const mutationDeadline=mutationStarted+60000;await probeRun(fresh,'immediate-after-write',mutationDeadline);await new Promise(ok=>setTimeout(ok,Math.max(0,500-(performance.now()-mutationStarted))))
  if(performance.now()>=mutationDeadline)throw Error('Mutation deadline exceeded before refresh')
  if(session.refresh){const s=performance.now();record.refresh={result:await session.refresh({timeoutMs:Math.max(1,60000-(performance.now()-mutationStarted))}),elapsedMs:performance.now()-s}}
  if(performance.now()>=mutationDeadline)throw Error('Mutation deadline exceeded during refresh')
  await probeRun(fresh,'after-refresh',mutationDeadline);record.mutationToEvidenceMs=performance.now()-mutationStarted;record.status='completed'
 }catch(error){record.status='failed';record.error=String(error)}
 finally{try{record.cleanup=await session?.close()}catch(e){record.cleanupError=String(e);record.status='failed'}if(originalMutationBytes)await writeFile(mutationFile,originalMutationBytes);try{record.finalSourceCheck=await sourceCheck(workspace)}catch(e){record.sourcePreservationError=String(e);record.status='failed'}record.finishedAt=new Date().toISOString();await persist()}
 console.log(json({provider,round,finished:true,status:record.status,error:record.error}).trim())
 if(record.cleanupError||record.sourcePreservationError)throw Error('Cleanup or source preservation failure; stop all measurements')
}
