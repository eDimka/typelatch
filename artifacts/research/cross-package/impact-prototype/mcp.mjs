#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {z} from 'zod'
import {createService} from './service.mjs'
const invoke=await createService()
const server=new McpServer({name:'typelatch-experimental-package-impact',version:'0.0.1'})
server.registerTool('package_evidence',{
 title:'Collect package export impact evidence',
 description:'Collect static users of named exports from an exact workspace package across configured package source files. Returns original export identity, source quotations, conservative installed dependency chains, validation script entries, lookalike candidates and explicit limits. Does not run builds or tests. Optional outputFile writes the full evidence JSON to a new file in the workspace root and returns a compact summary; transform that file to the requested final report. Existing files are never overwritten. This experimental tool supports package src trees and reports gaps rather than proving repository-wide absence.',
 inputSchema:{package:z.string().min(1).max(250),exports:z.array(z.string().min(1).max(250)).min(1).max(30),outputFile:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u).optional(),maxBytes:z.number().int().min(2000).max(60000).optional()},
},async(input,extra)=>invoke(input,{signal:extra.signal}))
await server.connect(new StdioServerTransport())
