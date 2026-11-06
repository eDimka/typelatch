import {access,mkdir,readFile,writeFile,lstat,readlink,symlink} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root=dirname(fileURLToPath(import.meta.url));
const exec=promisify(execFile),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const exists=async path=>{try{await access(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function isolatedEnv(cacheRoot) {
  const env={};
  for(const k of ['PATH','TMPDIR','LANG','LC_ALL'])if(process.env[k])env[k]=process.env[k];
  Object.assign(env,{HOME:join(cacheRoot,'home'),XDG_CONFIG_HOME:join(cacheRoot,'config'),XDG_CACHE_HOME:join(cacheRoot,'cache'),XDG_DATA_HOME:join(cacheRoot,'data'),CODEX_HOME:join(cacheRoot,'codex'),CLAUDE_CONFIG_DIR:join(cacheRoot,'claude'),CODEGRAPH_TELEMETRY:'0',DO_NOT_TRACK:'1',CODEGRAPH_NO_UPDATE_CHECK:'1',CODEGRAPH_NO_INSTALL_REFRESH:'1',GRAPHIFY_NO_AUTO_REFRESH:'1',GRAPHIFY_QUERY_LOG_DISABLE:'1',GRAPHIFY_BACKEND:'none',PYTHONHASHSEED:'0',PYTHONUNBUFFERED:'1'});
  return env;
}

export async function openProvider({provider,workspace,cacheRoot,mode='cold'}) {
  if(!['codegraph','graphify'].includes(provider))throw Error(`Unknown provider ${provider}`);
  if(!['cold','warm'].includes(mode))throw Error('mode must be cold or warm');
  workspace=resolve(workspace);cacheRoot=resolve(cacheRoot);
  const rel=relative(workspace,cacheRoot);
  if(!rel||!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw Error('cacheRoot must be outside workspace');
  const runId=new Date().toISOString().replaceAll(':','-')+'-'+process.pid;
  const logs=join(cacheRoot,'sessions',runId);
  await mkdir(logs,{recursive:true});
  const env=isolatedEnv(cacheRoot);
  await Promise.all(['home','config','cache','data','codex','claude'].map(p=>mkdir(join(cacheRoot,p),{recursive:true})));
  const state=join(cacheRoot,'index');
  await mkdir(state,{recursive:true});
  const binary=join(root,provider,provider==='codegraph'?'install/node_modules/.bin/codegraph':'venv/bin/graphify');
  const graph=join(state,'graph.json');
  const db=join(state,'codegraph.db');
  const pidPath=join(state,'daemon.pid');
  const indexed=await exists(provider==='codegraph'?db:graph);
  if((mode==='cold'&&indexed)||(mode==='warm'&&!indexed))throw Error(`${mode} mode does not match existing index state`);
  if(provider==='codegraph') {
    const link=join(workspace,'.codegraph');
    try {
      const stat=await lstat(link);
      if(!stat.isSymbolicLink()||resolve(dirname(link),await readlink(link))!==state)throw Error('Existing .codegraph is not the designated external state link');
    }catch(e){if(e.code==='ENOENT')await symlink(state,link,'dir');else throw e;}
  }else env.GRAPHIFY_OUT=state;
  const manifestBytes=await readFile(join(root,'runtime-manifest.json'));
  const setupRecord={schemaVersion:1,provider,mode,workspace,cacheRoot,runId,startedAt:new Date().toISOString(),runtimeManifestSha256:sha(manifestBytes),adapterSha256:sha(await readFile(fileURLToPath(import.meta.url))),commands:[],calls:[],cleanup:{}};
  const setupPath=join(logs,'session.json');
  const save=()=>writeFile(setupPath,JSON.stringify(setupRecord,null,2)+'\n');
  let sequence=0,watcher,watcherExit,watcherLog='',client,transport,closed=false,poisoned=false,ownedDaemon,priorDaemon;
  const launchspec=provider==='codegraph'?{command:binary,args:['serve','--mcp','--path',workspace],env,cwd:workspace}:{command:join(root,provider,'venv/bin/graphify-mcp'),args:[graph],env,cwd:workspace};
  setupRecord.launchspec=launchspec;

  async function command(label,args,timeoutMs=600000) {
    const t0=performance.now(),startedAt=new Date().toISOString();
    const p=spawn(binary,args,{cwd:workspace,env,stdio:['ignore','pipe','pipe'],detached:true});
    let stdout='',stderr='',timedOut=false,force;
    p.stdout.on('data',v=>{stdout+=v.toString();});p.stderr.on('data',v=>{stderr+=v.toString();});
    const timer=setTimeout(()=>{timedOut=true;try{process.kill(-p.pid,'SIGTERM');}catch{}force=setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL');}catch{}},3000);},timeoutMs);
    const result=await new Promise(resolve=>{p.on('error',e=>resolve({error:String(e)}));p.on('close',(exitCode,signal)=>resolve({exitCode,signal}));});
    clearTimeout(timer);clearTimeout(force);
    const record={label,command:binary,args,cwd:workspace,startedAt,elapsedMs:performance.now()-t0,...result,timedOut,stdout,stderr};
    setupRecord.commands.push(record);await save();
    if(record.exitCode!==0||timedOut||record.error)throw Error(`${label} failed; complete record at ${setupPath}`);
    return record;
  }

  async function close() {
    if(closed)return setupRecord.cleanup;closed=true;
    const cleanup=setupRecord.cleanup;
    try {await client?.close();cleanup.clientClosed=true;}catch(e){cleanup.clientError=String(e);}
    // The default proxy can create its daemon on the first call, after initialize.
    if(provider==='codegraph'&&!ownedDaemon&&await exists(pidPath)) {
      const daemon=JSON.parse(await readFile(pidPath,'utf8'));
      const preexisting=priorDaemon?.pid===daemon.pid||!(daemon.startedAt>=Date.parse(setupRecord.startedAt));
      setupRecord.daemon={...daemon,preexisting};
      if(!preexisting)ownedDaemon=daemon;
    }
    if(watcher) {
      try{process.kill(-watcher.pid,'SIGINT');}catch(e){if(e.code!=='ESRCH')cleanup.watcherSignalError=String(e);}
      for(let i=0;i<50&&!watcherExit;i++)await sleep(100);
      if(!watcherExit){try{process.kill(-watcher.pid,'SIGTERM');}catch{}for(let i=0;i<30&&!watcherExit;i++)await sleep(100);}
      cleanup.watcherExit=watcherExit??{unknown:true};
      setupRecord.watcher.log=watcherLog;
    }
    if(ownedDaemon&&alive(ownedDaemon.pid)) {
      try {
        const {stdout}=await exec('ps',['-p',String(ownedDaemon.pid),'-o','command=']);
        if(!stdout.includes(workspace)||!stdout.includes('codegraph'))throw Error('Owned daemon identity no longer matches workspace');
        cleanup.daemon={...ownedDaemon,command:stdout.trim(),signal:'SIGTERM'};
        process.kill(ownedDaemon.pid,'SIGTERM');
        for(let i=0;i<50&&alive(ownedDaemon.pid);i++)await sleep(100);
        cleanup.daemon.confirmedGone=!alive(ownedDaemon.pid);
        if(!cleanup.daemon.confirmedGone)throw Error('Owned daemon cleanup not confirmed');
      }catch(e){cleanup.daemonError=String(e);}
    }else if(ownedDaemon)cleanup.daemon={...ownedDaemon,alreadyGone:true};
    cleanup.completedAt=new Date().toISOString();await save();
    if(cleanup.daemonError||cleanup.clientError||cleanup.watcherExit?.unknown)throw Error(`Cleanup incomplete: ${setupPath}`);
    return cleanup;
  }

  try {
    const started=performance.now();
    if(mode==='cold')await command('initial-index',provider==='codegraph'?['init',workspace,'--yes']:['extract',workspace,'--code-only']);
    setupRecord.indexSetupMs=performance.now()-started;
    if(provider==='codegraph'&&await exists(pidPath)) {priorDaemon=JSON.parse(await readFile(pidPath,'utf8'));if(!alive(priorDaemon.pid))priorDaemon=undefined;}
    transport=new StdioClientTransport({...launchspec,stderr:'pipe'});
    let serverStderr='';transport.stderr?.on('data',v=>{serverStderr+=v.toString();setupRecord.serverStderr=serverStderr;});
    client=new Client({name:'typelatch-independent-provider-funnel',version:'1.0.0'});
    const connectStart=performance.now();await client.connect(transport,{timeout:60000});
    setupRecord.connectMs=performance.now()-connectStart;
    setupRecord.serverVersion=client.getServerVersion();
    setupRecord.instructions=client.getInstructions();
    setupRecord.schemas=await client.listTools({}, {timeout:30000});
    if(provider==='codegraph'&&await exists(pidPath)) {
      const daemon=JSON.parse(await readFile(pidPath,'utf8'));
      setupRecord.daemon={...daemon,preexisting:priorDaemon?.pid===daemon.pid};
      if(!setupRecord.daemon.preexisting)ownedDaemon=daemon;
    }
    if(provider==='graphify') {
      const watchStart=performance.now();
      watcher=spawn(binary,['watch',workspace],{cwd:workspace,env,stdio:['ignore','pipe','pipe'],detached:true});
      watcher.stdout.on('data',v=>{watcherLog+=v.toString();});watcher.stderr.on('data',v=>{watcherLog+=v.toString();});
      watcher.on('exit',(code,signal)=>{watcherExit={code,signal};});watcher.on('error',e=>{watcherExit={error:String(e)};});
      setupRecord.watcher={command:binary,args:['watch',workspace],pid:watcher.pid};
      for(let i=0;i<300&&!watcherLog.includes('[graphify watch] Watching')&&!watcherExit;i++)await sleep(100);
      setupRecord.watcher.ready=watcherLog.includes('[graphify watch] Watching');
      setupRecord.watcher.startMs=performance.now()-watchStart;
      if(!setupRecord.watcher.ready)throw Error('Graphify watcher readiness not observed');
    }
    setupRecord.readyAt=new Date().toISOString();await save();
    return {
      id:`${provider}@${provider==='codegraph'?'1.6.2':'0.9.103'}`,
      schemas:setupRecord.schemas.tools,instructions:setupRecord.instructions??'',setupRecord,launchspec,
      async call(name,args,{timeoutMs=30000}={}) {
        if(closed||poisoned)throw Error('Provider is closed or previous request did not complete');
        const record={sequence:++sequence,name,args,startedAt:new Date().toISOString()};const t0=performance.now();
        try {
          const response=await client.callTool({name,arguments:args},undefined,{timeout:timeoutMs});
          record.response=response;record.responseBytes=Buffer.byteLength(JSON.stringify(response));return response;
        }catch(e){record.error=String(e);poisoned=true;throw e;}
        finally {record.elapsedMs=performance.now()-t0;const file=`call-${String(sequence).padStart(4,'0')}.json`;await writeFile(join(logs,file),JSON.stringify(record,null,2)+'\n',{flag:'wx'});setupRecord.calls.push({sequence,name,file,elapsedMs:record.elapsedMs,error:record.error??null});await save();}
      },
      async refresh({timeoutMs=60000}={}) {
        if(closed||poisoned)throw Error('Provider is closed or previous request did not complete');
        return command('explicit-refresh',provider==='codegraph'?['sync',workspace]:['update',workspace],timeoutMs);
      },
      close,
    };
  }catch(e){setupRecord.error=String(e);await save();await close();throw e;}
}
