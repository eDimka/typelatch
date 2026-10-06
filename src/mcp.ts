#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { getSymbol, queryBrain } from "./query.js"
import { readStats, recordOutcome } from "./usage.js"

import { workspaceContextAsync, workspaceSearchAsync } from "./workspace/runtime.js"
import { validateWorkspace } from "./workspace/validate.js"
import { contextSchema, searchSchema, validationSchema } from "./workspace/schema.js"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
const server = new McpServer({ name: "typelatch", version })

server.registerTool("workspace_search", {
  title: "Search a whole workspace and its exact dependencies",
  description: "Start here when the relevant file or package is unknown. Search local source, internal declarations, tests, docs, configuration and exact installed or locked dependency indexes. Supply an absolute workspaceRoot; file is an optional ranking hint. Use detail=compact for bounded previews with explicit omissions and exact dependency inspection arguments. Refreshes a local content index without downloads or executing project code. Inspect coverage gaps and limits. Results are lexical candidates, not compiler resolution or validation. Follow workspace hits with workspace_context, dependency hits with library_symbol using the returned exact version, and edits with workspace_validate.",
  inputSchema: searchSchema.shape
}, async (input, extra) => {
  const response = await workspaceSearchAsync(input, { signal: extra.signal })
  return { content: [{ type: "text" as const, text: JSON.stringify(response) }], structuredContent: response }
})

server.registerTool(
  "library_search",
  {
    title: "Search exact-version library knowledge",
    description: "Search locally installed library symbols, documentation, relationships, and source evidence. The query is recorded only in the local Typelatch usage database.",
    inputSchema: {
      package: z.string().describe("npm package name"),
      version: z.string().optional().describe("Exact version; newest installed brain is used when omitted"),
      question: z.string().min(1).describe("Natural-language question or exact API name"),
      limit: z.number().int().min(1).max(20).optional()
    }
  },
  async ({ package: packageName, version, question, limit }) => {
    const response = queryBrain(packageName, question, {
      ...(version ? { version } : {}),
      ...(limit ? { limit } : {})
    })
    return {
      content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    }
  }
)

server.registerTool(
  "library_symbol",
  {
    title: "Find an exact library symbol",
    description: "Look up a case-sensitive API symbol and its relationships in an installed brain. Use the complete symbol and exact package version returned by search. Qualified identities never fall back to another module. Bare names expose ambiguity and omitted candidate counts in lookup.",
    inputSchema: {
      package: z.string(),
      version: z.string().optional(),
      symbol: z.string().min(1)
    }
  },
  async ({ package: packageName, version, symbol }) => {
    const response = getSymbol(packageName, symbol, { ...(version ? { version } : {}) })
    return {
      content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
      structuredContent: response
    }
  }
)

server.registerTool(
  "library_feedback",
  {
    title: "Record a Typelatch result outcome",
    description: "Correlate a prior query with whether its recommendation was used and whether code compiled and tests passed.",
    inputSchema: {
      queryId: z.string().uuid(),
      accepted: z.boolean().optional(),
      compilePassed: z.boolean().optional(),
      testsPassed: z.boolean().optional(),
      notes: z.string().max(1000).optional()
    }
  },
  async ({ queryId, accepted, compilePassed, testsPassed, notes }) => {
    recordOutcome(queryId, {
      ...(accepted === undefined ? {} : { accepted }),
      ...(compilePassed === undefined ? {} : { compilePassed }),
      ...(testsPassed === undefined ? {} : { testsPassed }),
      ...(notes === undefined ? {} : { notes })
    })
    return { content: [{ type: "text" as const, text: `Outcome recorded for ${queryId}` }] }
  }
)

server.registerTool(
  "library_stats",
  {
    title: "Read local Typelatch usage statistics",
    description: "Return local query, latency, hit-rate, context-size, and coding-outcome aggregates.",
    inputSchema: {}
  },
  async () => {
    const stats = readStats()
    return {
      content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
      structuredContent: stats
    }
  }
)

server.registerTool("workspace_context", {
  title: "Resolve TypeScript workspace context",
  description: "Inspect the project's installed TypeScript language service, with optional exact-version brain discovery. Positions are zero-based UTF-16 offsets. Does not type-check or run tests; artifact equivalence stays unknown.",
  inputSchema: contextSchema.shape
}, async (input, extra) => {
  const response = await workspaceContextAsync(contextSchema.parse(input), { signal: extra.signal })
  return { content: [{ type: "text" as const, text: JSON.stringify(response) }], structuredContent: response }
})

server.registerTool("workspace_validate", {
  title: "Validate a TypeScript project and record execution evidence",
  description: "Type-check a leaf tsconfig with its installed compiler. Runs only the explicitly supplied testCommand argv, with a timeout, after checking passes. Test commands execute local code: supply one only when the user authorized that validation. Unsaved overlays cannot be runtime-tested. Stores evidence separately from agent-reported feedback unless record=false or TYPELATCH_USAGE=off.",
  inputSchema: validationSchema.shape
}, async (input, extra) => {
  const response = await validateWorkspace(validationSchema.parse(input), { signal: extra.signal })
  return { content: [{ type: "text" as const, text: JSON.stringify(response) }], structuredContent: response }
})

await server.connect(new StdioServerTransport())
