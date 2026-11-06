import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,lstat,symlink,realpath,access} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';

const here=import.meta.dirname,runtime=join(here,'runtime'),binary=join(runtime,'node_modules/@colbymchenry/codegraph-darwin-arm64/bin/codegraph'),ownerNonce=randomUUID(),exec=promisify(execFile);
const sleep=ms=>new Promise(done=>setTimeout(done,ms)),save=(path,value,options={})=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600,...options});
const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const readJson=async path=>await exists(path)?JSON.parse(await readFile(path,'utf8')):null;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
export const toolNames=['explore','node','search','callers','callees','impact','files','status'].map(name=>'codegraph_'+name);
export function serverSpec({workspace='{workspace}',state='{state}'}={}){
 const base=join(state,'codegraph');
 return {command:binary,args:['serve','--mcp','--path',workspace],cwd:workspace,env:{...Object.fromEntries(['PATH','TMPDIR','LANG','LC_ALL'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[])),HOME:join(base,'home'),XDG_CONFIG_HOME:join(base,'config'),XDG_CACHE_HOME:join(base,'cache'),XDG_DATA_HOME:join(base,'data'),CODEX_HOME:join(base,'codex'),CLAUDE_CONFIG_DIR:join(base,'claude'),CODEGRAPH_TELEMETRY:'0',DO_NOT_TRACK:'1',CODEGRAPH_NO_UPDATE_CHECK:'1',CODEGRAPH_NO_INSTALL_REFRESH:'1',CODEGRAPH_NO_DOWNLOAD:'1',CODEGRAPH_MCP_TOOLS:'explore,node,search,callers,callees,impact,files,status'},startup_timeout_sec:600,tool_timeout_sec:180,tools:toolNames};
}
async function externalPaths(workspace,state){
 assert(isAbsolute(workspace)&&isAbsolute(state));workspace=await realpath(workspace);await mkdir(state,{recursive:true});state=await realpath(state);
 const rel=relative(workspace,state);assert(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel),'Provider state must be outside workspace');return {workspace,state};
}
async function ownedProcesses(workspace){
 const {stdout}=await exec('/bin/ps',['-axo','pid=,command=']);return stdout.split('\n').flatMap(line=>{const match=line.trim().match(/^(\d+)\s+(.*)$/u);return match&&match[2].startsWith(runtime+'/')&&match[2].endsWith('codegraph.js serve --mcp --path '+workspace)?[{pid:Number(match[1]),command:match[2]}]:[];});
}
export function readiness(status,writerActive){
 const reasons=[];if(status?.initialized!==true||!(status.fileCount>0))reasons.push('Index lacks initialized source');if(status?.index?.state!=='complete')reasons.push('Index incomplete');if(status?.index?.pendingRefs!==0)reasons.push('Pending references unknown or nonzero');if(status?.index?.reindexRecommended!==false)reasons.push('Reindex required or unknown');if(status?.worktreeMismatch!==null)reasons.push('Workspace mismatch or unknown');for(const kind of ['added','modified','removed'])if(status?.pendingChanges?.[kind]!==0)reasons.push('Pending '+kind);if(writerActive)reasons.push('Writer active');return {ready:reasons.length===0,reasons};
}
export async function runSetupCommand(spec,args,timeoutMs=600000){
 const start=performance.now(),child=spawn(spec.command,args,{cwd:spec.cwd,env:spec.env,stdio:['ignore','pipe','pipe'],detached:true});let stdout='',stderr='',timedOut=false,force;
 child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGTERM');}catch{}force=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},3000);},timeoutMs);
 const result=await new Promise(done=>{child.once('error',error=>done({error:String(error)}));child.once('close',(exitCode,signal)=>done({exitCode,signal}));});clearTimeout(timer);clearTimeout(force);
 const groupAlive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}},termination=[];
 // A setup parent can exit while a detached-group descendant remains alive.
 for(const [signal,attempts] of [['SIGTERM',20],['SIGKILL',120]]){
  if(!groupAlive())break;try{process.kill(-child.pid,signal);termination.push(signal);}catch(error){if(error.code!=='ESRCH')throw error;}
  for(let i=0;i<attempts&&groupAlive();i++)await sleep(25);
 }
 return {command:spec.command,args,pid:child.pid??null,...result,timedOut,stdout,stderr,processGroupStopped:!groupAlive(),termination,elapsedMs:performance.now()-start};
}
export async function cleanupFailedStart({workspace,state}){return cleanup(await externalPaths(workspace,state));}
async function cleanup({workspace,state}){
 const receipt=await readJson(join(state,'codegraph-lifecycle.json'));if(!receipt)return {stopped:true,requiresCaptureGroupStopped:true,scope:'No owned setup launch'};
 assert.equal(receipt.ownerNonce,ownerNonce);assert.equal(receipt.workspace,workspace);assert.equal(receipt.state,state);
 const daemon=await readJson(join(state,'codegraph/index/daemon.pid')),termination=[];
 if(daemon&&alive(daemon.pid)){
  assert(daemon.startedAt>=Date.parse(receipt.startedAt),'Refusing to stop a daemon predating setup');assert((await ownedProcesses(workspace)).some(row=>row.pid===daemon.pid),'Daemon identity mismatch');
  process.kill(daemon.pid,'SIGTERM');termination.push({pid:daemon.pid,signal:'SIGTERM'});for(let i=0;i<50&&alive(daemon.pid);i++)await sleep(100);
  if(alive(daemon.pid)){assert((await ownedProcesses(workspace)).some(row=>row.pid===daemon.pid));process.kill(daemon.pid,'SIGKILL');termination.push({pid:daemon.pid,signal:'SIGKILL'});for(let i=0;i<30&&alive(daemon.pid);i++)await sleep(100);}
 }
 const remaining=await ownedProcesses(workspace),setupGroupsStopped=receipt.commands.every(row=>row.processGroupStopped===true),result={stopped:remaining.length===0&&setupGroupsStopped,scope:'Owned setup groups and workspace CodeGraph daemon. Codex must separately confirm its MCP process group stopped.',requiresCaptureGroupStopped:true,setupGroupsStopped,termination,remaining,completedAt:new Date().toISOString()};await save(join(state,'codegraph-cleanup.json'),result);return result;
}
export async function start({workspace,state,arm='codegraph'}){
 ({workspace,state}=await externalPaths(workspace,state));const base=join(state,'codegraph'),index=join(base,'index'),link=join(workspace,'.codegraph');await mkdir(base);await mkdir(index);
 assert.equal(await exists(link),false,'Fresh setup cannot reuse an existing workspace index');
 // lstat also rejects a dangling prior link, which access alone would miss.
 try{await lstat(link);throw Error('Existing index path');}catch(error){if(error.code!=='ENOENT')throw error;}
 const receipt={schemaVersion:1,provider:'codegraph',version:'1.6.2',arm,ownerNonce,workspace,state,startedAt:new Date().toISOString(),status:'starting',commands:[],additionalSetupMcpClient:false,modelQueriesDuringSetup:0};await save(join(state,'codegraph-lifecycle.json'),receipt,{flag:'wx'});
 try{
  for(const name of ['home','config','cache','data','codex','claude'])await mkdir(join(base,name));await symlink(index,link,'dir');const spec=serverSpec({workspace,state});receipt.launchspec=spec;
  const initial=await runSetupCommand(spec,['init',workspace,'--yes']);receipt.commands.push(initial);await save(join(state,'codegraph-lifecycle.json'),receipt);assert(initial.exitCode===0&&initial.signal===null&&!initial.error&&!initial.timedOut&&initial.processGroupStopped,'Initial index failed');
  const status=await runSetupCommand(spec,['status',workspace,'--json'],60000);receipt.commands.push(status);assert(status.exitCode===0&&status.signal===null&&!status.error&&!status.timedOut&&status.processGroupStopped,'Status failed');receipt.readiness=readiness(JSON.parse(status.stdout),await exists(join(index,'codegraph.lock')));assert(receipt.readiness.ready,receipt.readiness.reasons.join('; '));
  receipt.status='ready';receipt.readyAt=new Date().toISOString();await save(join(state,'codegraph-lifecycle.json'),receipt);return {evidence:receipt,close:()=>cleanup({workspace,state})};
 }catch(error){receipt.status='failed';receipt.error=String(error);await save(join(state,'codegraph-lifecycle.json'),receipt);receipt.cleanup=await cleanup({workspace,state}).catch(error=>({stopped:false,error:String(error)}));await save(join(state,'codegraph-lifecycle.json'),receipt);throw error;}
}
