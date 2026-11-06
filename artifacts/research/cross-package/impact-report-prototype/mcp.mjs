#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {z} from 'zod'
import {createService} from '../impact-prototype/service.mjs'
const invoke=await createService()
const server=new McpServer({name:'typelatch-experimental-impact-report',version:'0.0.2'})
server.registerTool('package_impact_report',{
 title:'Write a package impact evidence report',
 description:'Write exact package export evidence to a NEW JSON file in the workspace root. Collects configured static consumers, original export identities, exact source quotations, installed dependency chains, script entries, lookalike candidates and explicit gaps. Returns a compact summary and artifact hash. The saved JSON contains every collected fact and issue; transform that same file to the requested answer schema. Existing files are never overwritten. Scope is configured package src trees and explicit import/export routes, not arbitrary value propagation or dynamic runtime impact. Does not execute builds or tests.',
 inputSchema:{package:z.string().min(1).max(250),exports:z.array(z.string().min(1).max(250)).min(1).max(30),outputFile:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u)},
},async(input,extra)=>invoke({...input,maxBytes:8000},{signal:extra.signal}))
await server.connect(new StdioServerTransport())
