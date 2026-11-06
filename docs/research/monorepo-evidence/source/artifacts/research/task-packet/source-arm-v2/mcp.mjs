#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createService, settings } from './service.mjs'
const config=await settings(),invoke=await createService(config)
const server=new McpServer({name:'typelatch-experimental-source-packet',version:'0.0.2'})
server.registerTool('workspace_evidence',{title:'Inspect bounded source evidence',description:'Retrieve exact source excerpts from the fixed workspace. Lexical candidates remain ambiguous; empty results do not prove absence. Check omissions. No installed API lookup, compiler check or tests are run. Use native tools for missing facts and validation.',inputSchema:{question:z.string().trim().min(1).max(2000),file:z.string().min(1).optional()}},async(input,extra)=>(await invoke(input,{signal:extra.signal})).response)
await server.connect(new StdioServerTransport())
