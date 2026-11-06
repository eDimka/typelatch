import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join,dirname,resolve} from 'node:path'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
test('dedicated MCP requires a destination and writes exact bounded evidence without overwriting it',async()=>{
 const root=mkdtempSync(join(tmpdir(),'typelatch-impact-mcp-'))
 const put=(path,value)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n')}
 put('package.json',{private:true,workspaces:['packages/*']})
 put('tsconfig.json',{compilerOptions:{target:'ES2022',module:'CommonJS',strict:true},include:['packages/*/src']})
 put('packages/api/package.json',{name:'@transport/api',version:'1.0.0',types:'src/index.ts'})
 put('packages/api/src/index.ts','export function parse() { return "ready" }\n')
 put('packages/consumer/package.json',{name:'@transport/consumer',version:'1.0.0',dependencies:{'@transport/api':'workspace:*'}})
 put('packages/consumer/src/index.ts','import {parse} from "@transport/api" // orchid-proof-739\nexport const value = parse()\n')
 mkdirSync(join(root,'node_modules/@transport'),{recursive:true});symlinkSync('../../packages/api',join(root,'node_modules/@transport/api'))
 for(const args of [['init','--quiet'],['add','.']])assert.equal(spawnSync('/usr/bin/git',args,{cwd:root}).status,0)
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve(import.meta.dirname,'mcp.mjs')],cwd:root,env:{TYPELATCH_IMPACT_RUNTIME:resolve('artifacts/paired-agent/candidate/runtime/node_modules/typelatch'),TYPELATCH_USAGE:'off'},stderr:'pipe'})
 const client=new Client({name:'impact-qualification',version:'1.0.0'})
 try{
  await client.connect(transport)
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['package_impact_report'])
  const missing=await client.callTool({name:'package_impact_report',arguments:{package:'@transport/api',exports:['parse']}})
  assert.equal(missing.isError,true)
  const response=await client.callTool({name:'package_impact_report',arguments:{package:'@transport/api',exports:['parse'],outputFile:'answer.json'}})
  assert(Buffer.byteLength(JSON.stringify(response))<9500);assert(!response.isError);assert.equal(response.structuredContent,undefined)
  const body=JSON.parse(response.content[0].text),bytes=readFileSync(join(root,'answer.json')),saved=JSON.parse(bytes)
  assert.equal(body.target.package,'@transport/api');assert(body.direct.some(row=>row.evidence.quote.includes('orchid-proof-739')))
  assert.equal(saved.direct.length,1);assert.equal(saved.packageDependents[0].package,'@transport/consumer')
  assert.equal(body.artifact.bytes,bytes.length);assert.equal(body.artifact.allCollectedFactsSaved,true)
  const rejected=await client.callTool({name:'package_impact_report',arguments:{package:'@transport/api',exports:['parse'],outputFile:'answer.json'}})
  assert.equal(rejected.isError,true);assert.deepEqual(readFileSync(join(root,'answer.json')),bytes)
  const escaped=await client.callTool({name:'package_impact_report',arguments:{package:'@transport/api',exports:['parse'],outputFile:'../outside.json'}})
  assert.equal(escaped.isError,true)
 }finally{await client.close();await transport.close();rmSync(root,{recursive:true,force:true})}
})
