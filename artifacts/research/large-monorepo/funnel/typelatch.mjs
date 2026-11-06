import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { collectNative } from './native.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..')
export async function openProvider({workspace,cacheRoot,mode='cold'}) {
 const started=performance.now();await mkdir(cacheRoot,{recursive:true})
 const command=process.execPath,args=[join(root,'artifacts/paired-agent/candidate/runtime/node_modules/typelatch/dist/mcp.js')]
 const env={...process.env,TYPELATCH_HOME:join(cacheRoot,'index'),TYPELATCH_USAGE:'off'}
 const client=new Client({name:'monorepo-tool-screen',version:'1.0.0'}),transport=new StdioClientTransport({command,args,env,cwd:workspace,stderr:'pipe'})
 let stderr='';transport.stderr?.on('data',v=>stderr+=v)
 await client.connect(transport,{timeout:60000});const schemas=(await client.listTools()).tools
 const setupRecord={provider:'typelatch',mode,elapsedMs:performance.now()-started,source:'frozen compact candidate 0.4.0',archiveSha256:'8dc79e045f0acf67cc25a6090d62e6b2aecc424a1749b1c4843a10868a7b9d3f'}
 return {id:'typelatch-0.4.0-compact',schemas,instructions:client.getInstructions(),setupRecord,launchspec:{command,args,env,cwd:workspace},
  call:(name,input,{timeoutMs=60000}={})=>client.callTool({name,arguments:input},undefined,{timeout:timeoutMs}),
  async close(){await client.close();await writeFile(join(cacheRoot,'stderr.log'),stderr)}
 }
}
export async function collectProbe({probe,session,workspace,native}) {
 const c=probe.context
 if(probe.family==='ownership'){
  const configs=await native.configs({files:c.files});const results=[]
  for(const f of configs.files){const config=f.configs.sort((a,b)=>b.path.length-a.path.length)[0];if(config)results.push(await session.call('workspace_context',{config:join(workspace,config.path),file:join(workspace,f.file)}))}
  return {configs,results}
 }
 if(c.file&&c.importSpecifier){
  const configs=await native.configs({files:[c.file]}),config=configs.files[0]?.configs.sort((a,b)=>b.path.length-a.path.length)[0]
  if(!config)return {limitations:['No owning config discovered'],configs}
  const responses=[];for(const symbol of ['sync','execa'])responses.push(await session.call('workspace_context',{config:join(workspace,config.path),file:join(workspace,c.file),importSpecifier:c.importSpecifier,symbol}))
  return {configs,responses}
 }
 if(probe.family==='installed-api'||c.packageName)return collectNative({probe,native})
 const response=await session.call('workspace_search',{workspaceRoot:join(workspace,...(c.directories??[])),question:probe.question,scope:'workspace',detail:['negative','cross-package','ambiguity'].includes(probe.family)?'compact':'source',limit:6,timeoutMs:60000})
 if(['negative','cross-package'].includes(probe.family))return {response,native:await collectNative({probe,native})}
 return {response}
}
