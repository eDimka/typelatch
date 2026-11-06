import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { projectSourceEvidence } from './projection.mjs'
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../../../..')
const inside=(root,file)=>{const value=relative(root,file);return value!=='..'&&!value.startsWith('../')&&!isAbsolute(value)}
export async function settings(env=process.env,cwd=process.cwd()){
 const workspaceRoot=await realpath(resolve(env.TYPELATCH_PACKET_WORKSPACE_ROOT||cwd)),byteLimit=Number(env.TYPELATCH_PACKET_BYTES||8192)
 if(![4096,8192,12288].includes(byteLimit))throw Error('Byte limit must be 4096, 8192 or 12288')
 const runtimeRoot=await realpath(resolve(env.TYPELATCH_PACKET_RUNTIME_ROOT||resolve(repo,'artifacts/paired-agent/candidate/runtime/node_modules/typelatch')))
 const diagnosticDirectory=env.TYPELATCH_PACKET_DIAGNOSTICS?resolve(env.TYPELATCH_PACKET_DIAGNOSTICS):null
 if(diagnosticDirectory){await mkdir(diagnosticDirectory,{recursive:true});if(inside(workspaceRoot,await realpath(diagnosticDirectory)))throw Error('Diagnostics must stay outside the agent workspace')}
 return{workspaceRoot,byteLimit,runtimeRoot,diagnosticDirectory}
}
export async function createService(config){
 const runtime=await import(pathToFileURL(resolve(config.runtimeRoot,'dist/workspace/runtime.js')).href)
 const schemas=await import(pathToFileURL(resolve(config.runtimeRoot,'dist/workspace/schema.js')).href)
 const typescript=createRequire(pathToFileURL(resolve(config.runtimeRoot,'package.json')))('typescript')
 let sequence=0
 return async(input,{signal}={})=>{
  if(!input||Object.keys(input).some(key=>!['question','file'].includes(key)))throw Error('Expected question and optional file only')
  if(typeof input.question!=='string'||!input.question.trim()||input.question.length>2000)throw Error('Question must be 1 to 2000 characters')
  let file
  if(input.file!==undefined){if(typeof input.file!=='string'||!input.file.trim())throw Error('Invalid file hint');file=await realpath(resolve(config.workspaceRoot,input.file));if(!inside(config.workspaceRoot,file))throw Error('File hint escapes fixed workspace')}
  const request=schemas.searchSchema.parse({workspaceRoot:config.workspaceRoot,question:input.question.trim(),...(file?{file}:{}),scope:'workspace',detail:'source',limit:6,timeoutMs:60000})
  const start=performance.now(),raw=await runtime.workspaceSearchAsync(request,{signal}),retrievalMs=performance.now()-start
  let projection
  try{projection=await projectSourceEvidence(raw,config.workspaceRoot,{byteLimit:config.byteLimit,typescript,signal})}
  catch(error){if(config.diagnosticDirectory)await writeFile(resolve(config.diagnosticDirectory,process.pid+'-'+String(++sequence).padStart(4,'0')+'.json'),JSON.stringify({schemaVersion:1,kind:'experimental-source-packet-failure',request,raw,error:{message:String(error),code:error.code??null,expectedSha256:error.expectedSha256??null,observedSha256:error.observedSha256??null},measurement:{...error.measurement,retrievalMs,serviceMs:performance.now()-start,backendCalls:1}},null,2)+'\n',{flag:'wx',mode:0o600});throw error}
  const response={content:[{type:'text',text:projection.text}],structuredContent:{text:projection.text}}
  const measurement={...projection.measurement,retrievalMs,serviceMs:performance.now()-start,backendCalls:1,responseWireBytes:Buffer.byteLength(JSON.stringify(response)),diagnosticPersistenceIncluded:false}
  if(config.diagnosticDirectory){await writeFile(resolve(config.diagnosticDirectory,process.pid+'-'+String(++sequence).padStart(4,'0')+'.json'),JSON.stringify({schemaVersion:1,kind:'experimental-source-packet-observation',request,raw,projection,responseSha256:createHash('sha256').update(JSON.stringify(response)).digest('hex'),measurement},null,2)+'\n',{flag:'wx',mode:0o600})}
  return{response,measurement}
 }
}
