import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here=dirname(fileURLToPath(import.meta.url))
const hash=value=>createHash('sha256').update(value).digest('hex')
const json=value=>JSON.stringify(value)

export async function openProvider({provider,workspace,cacheRoot,mode='cold'}) {
 workspace=await realpath(workspace);cacheRoot=resolve(cacheRoot)
 await mkdir(cacheRoot,{recursive:true})
 if(provider==='serena') return openSerena({workspace,cacheRoot,mode})
 if(provider==='typescript'||provider==='tsserver') return openTypeScript({workspace,cacheRoot,mode})
 throw Error('Unknown provider: '+provider)
}

async function openSerena({workspace,cacheRoot,mode}) {
 const started=performance.now(),home=join(cacheRoot,'serena-home'),projectData=join(cacheRoot,'project-data')
 await mkdir(home,{recursive:true});await mkdir(projectData,{recursive:true})
 const config={projects:[workspace],agent_interface:'REPL',web_dashboard:false,web_dashboard_open_on_launch:false,gui_log_window:false,
  project_serena_folder_location:projectData,trusted_project_path_patterns:[workspace],
  ls_specific_settings:{typescript:{ls_path:join(here,'ls-runtime/node_modules/.bin/typescript-language-server'),typescript_version:'5.5.4',typescript_language_server_version:'5.1.3',indexing_timeout:120,indexing_start_grace:10}},
  log_level:'INFO'}
 await writeFile(join(home,'serena_config.yml'),json(config)+'\n')
 await writeFile(join(projectData,'project.yml'),json({project_name:'isolated-provider-workspace',language_servers:['typescript'],encoding:'utf-8',ignore_all_files_in_gitignore:true,ls_workspace_folders:['.'],read_only:true})+'\n')
 const env={...process.env,SERENA_HOME:home,XDG_CACHE_HOME:join(cacheRoot,'xdg-cache'),XDG_CONFIG_HOME:join(cacheRoot,'xdg-config'),PYTHONNOUSERSITE:'1',PYTHONUNBUFFERED:'1',npm_config_cache:join(here,'npm-cache'),npm_config_offline:'true'}
 const command=join(here,'venv/bin/serena')
 const args=['start-mcp-server','--project',workspace,'--agent-interface','REPL','--transport','stdio','--enable-web-dashboard','false','--enable-gui-log-window','false','--open-web-dashboard','false','--log-level','INFO']
 const client=new Client({name:'isolated-readonly-provider-qualification',version:'1.0.0'})
 const transport=new StdioClientTransport({command,args,env,cwd:workspace,stderr:'pipe'})
 let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk.toString()})
 const calls=[]
 try {
  await client.connect(transport,{timeout:600000})
  const catalog=await client.listTools()
  const setupRecord={provider:'serena',mode,version:'2.1.0',commit:'5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc',elapsedMs:performance.now()-started,
   catalogBytes:Buffer.byteLength(json(catalog)),config,launch:{command,args,env:Object.fromEntries(['SERENA_HOME','XDG_CACHE_HOME','XDG_CONFIG_HOME','PYTHONNOUSERSITE','PYTHONUNBUFFERED','npm_config_cache','npm_config_offline'].map(key=>[key,env[key]]))},
   compilerVersionEvidence:'Await TypeScript server version notification in stderr log',compilerRuntimeNotifications:[]}
  return {id:'serena-2.1.0-repl',schemas:catalog.tools,instructions:client.getInstructions?.()??null,setupRecord,calls,launchSpec:setupRecord.launch,
   async call(name,args,{timeoutMs=60000}={}) {const start=performance.now();try{const response=await client.callTool({name,arguments:args},undefined,{timeout:timeoutMs});setupRecord.compilerRuntimeNotifications=stderr.split('\n').filter(line=>line.includes('TypeScript server version notification received'));calls.push({name,args,elapsedMs:performance.now()-start,responseBytes:Buffer.byteLength(json(response)),isError:response.isError??false});return response}catch(error){calls.push({name,args,elapsedMs:performance.now()-start,error:String(error)});throw error}},
   getStderr:()=>stderr,
   async close(){await client.close();await writeFile(join(cacheRoot,'serena.stderr.log'),stderr);await writeFile(join(cacheRoot,'session-record.json'),json({setupRecord,calls,stderrBytes:Buffer.byteLength(stderr)})+'\n')}
  }
 }catch(error){await client.close().catch(()=>{});await writeFile(join(cacheRoot,'serena.stderr.log'),stderr);throw error}
}

async function openTypeScript({workspace,cacheRoot,mode}) {
 const started=performance.now(),packageRoot=await realpath(join(workspace,'node_modules/typescript'))
 const manifest=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'))
 if(manifest.version!=='5.5.4')throw Error('Expected repository TypeScript5.5.4, received '+manifest.version)
 const serverPath=join(packageRoot,'lib/tsserver.js'),serverHash=hash(await readFile(serverPath))
 const command=process.execPath,args=[serverPath,'--disableAutomaticTypingAcquisition','--logVerbosity','terse','--logFile',join(cacheRoot,'tsserver.log')]
 const child=spawn(command,args,{cwd:workspace,env:{...process.env,TSS_LOG:'',npm_config_offline:'true'},stdio:['pipe','pipe','pipe']})
 let buffer=Buffer.alloc(0),stderr='',sequence=0,closed=false
 const pending=new Map(),events=[],calls=[],openFiles=new Set()
 child.stderr.on('data',value=>{stderr+=value.toString()})
 const fail=error=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(error)}pending.clear()}
 child.on('error',fail);child.on('exit',(code,signal)=>{closed=true;fail(Error('tsserver exited '+code+' '+signal))})
 child.stdout.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk])
  while(true){const start=buffer.indexOf('Content-Length:');if(start<0)break;if(start>0)buffer=buffer.subarray(start);const headerEnd=buffer.indexOf('\r\n\r\n');if(headerEnd<0)break;const match=buffer.subarray(0,headerEnd).toString().match(/Content-Length:\s*(\d+)/i);if(!match){fail(Error('Invalid tsserver header'));break}const length=Number(match[1]);if(buffer.length<headerEnd+4+length)break;const body=buffer.subarray(headerEnd+4,headerEnd+4+length);buffer=buffer.subarray(headerEnd+4+length);let message;try{message=JSON.parse(body.toString())}catch(error){fail(error);continue}if(message.type==='response'&&pending.has(message.request_seq)){const request=pending.get(message.request_seq);pending.delete(message.request_seq);clearTimeout(request.timer);request.resolve(message)}else events.push(message)}
 })
 const notifications=new Set(['open','close','reload','reloadProjects','exit'])
 const request=(command,args={},timeoutMs=60000)=>new Promise((resolve,reject)=>{
  if(closed){reject(Error('tsserver is closed'));return}if(command==='open'&&args.file)openFiles.add(args.file);if(command==='close'&&args.file)openFiles.delete(args.file);const seq=++sequence,message={seq,type:'request',command,arguments:args}
  if(notifications.has(command)){child.stdin.write(json(message)+'\n');resolve({type:'notification-sent',command,seq});return}
  const timer=setTimeout(()=>{pending.delete(seq);reject(Error('tsserver timeout: '+command))},timeoutMs)
  pending.set(seq,{resolve,reject,timer});child.stdin.write(json(message)+'\n')
 })
 const status=await request('status')
 if(status.body?.version!=='5.5.4'){child.kill();throw Error('Running tsserver did not report5.5.4: '+json(status))}
 const setupRecord={provider:'typescript',mode,elapsedMs:performance.now()-started,compiler:{version:manifest.version,packageRoot,serverPath,serverSha256:serverHash,status},launch:{command,args},automaticTypeAcquisition:false}
 return {id:'typescript-5.5.4-tsserver',instructions:'Use tsserver_batch to send native TypeScript protocol requests. File positions are1-based line and offset. Open a file before quickinfo, definitionAndBoundSpan, references, or projectInfo. Native reads and targeted search remain available.',
  schemas:[{name:'tsserver_batch',description:'Batch native repository TypeScript language-service requests. Responses and failures are returned unchanged.',inputSchema:{type:'object',properties:{requests:{type:'array',items:{type:'object',properties:{command:{type:'string'},arguments:{type:'object'}},required:['command'],additionalProperties:false},maxItems:20}},required:['requests'],additionalProperties:false}}],setupRecord,calls,
  async call(name,input,{timeoutMs=60000}={}){if(name!=='tsserver_batch'||!Array.isArray(input.requests)||input.requests.length>20)throw Error('Invalid tsserver batch');const start=performance.now(),responses=[];try{for(const item of input.requests){const remaining=timeoutMs-(performance.now()-start);if(remaining<=0)throw Error('tsserver batch deadline exceeded');const sent=performance.now();const response=await request(item.command,item.arguments??{},remaining);responses.push({command:item.command,response,elapsedMs:performance.now()-sent})}const result={compilerVersion:manifest.version,responses};const response={content:[{type:'text',text:json(result)}],structuredContent:result};calls.push({name,args:input,elapsedMs:performance.now()-start,protocolRequests:input.requests.length,responseBytes:Buffer.byteLength(json(response))});return response}catch(error){calls.push({name,args:input,elapsedMs:performance.now()-start,protocolRequests:input.requests.length,completed:responses,error:String(error)});throw error}},
  async refresh({timeoutMs=60000}={}){const started=performance.now(),requests=[...openFiles].map(file=>({command:'reload',arguments:{file,tmpfile:file}}));requests.push({command:'reloadProjects'},{command:'status'});const results=[];while(requests.length){const remaining=timeoutMs-(performance.now()-started);if(remaining<=0)throw Error('tsserver refresh deadline exceeded');results.push(await this.call('tsserver_batch',{requests:requests.splice(0,20)},{timeoutMs:remaining}))}return results},
  getStderr:()=>stderr,
  async close(){if(!closed){child.stdin.end(json({seq:++sequence,type:'request',command:'exit'})+'\n');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},2000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}await writeFile(join(cacheRoot,'session-record.json'),json({setupRecord,calls,events,stderr})+'\n')}
 }
}
