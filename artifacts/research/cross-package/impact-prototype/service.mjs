import {realpath} from 'node:fs/promises'
import {resolve} from 'node:path'
import {packageEvidence} from './evidence.mjs'
import {projectResponse} from './projection.mjs'
export async function createService({workspaceRoot=process.cwd(),runtimeRoot=process.env.TYPELATCH_IMPACT_RUNTIME??resolve(import.meta.dirname,'../../../paired-agent/candidate/runtime/node_modules/typelatch')}={}){
 const root=await realpath(workspaceRoot),runtime=await realpath(runtimeRoot)
 return async(input,{signal}={})=>{
  const evidence=await packageEvidence({workspaceRoot:root,package:input.package,exports:input.exports},{runtimeRoot:runtime,signal})
  const response=projectResponse(evidence,{workspaceRoot:root,outputFile:input.outputFile,maxBytes:input.maxBytes??30000})
  return {content:[{type:'text',text:JSON.stringify(response)}]}
 }
}
