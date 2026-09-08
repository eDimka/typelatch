import { existsSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { z } from "zod"
import { openBrainDatabase } from "../database.js"
import { brainPath } from "../paths.js"
import { queryBrain } from "../query.js"
import { inside, inventoryWorkspace, type Dependency } from "./inventory.js"
import { searchSchema } from "./schema.js"
import { scoreCandidate, searchWorkspaceIndex, type SearchChunk } from "./search-index.js"

export type SearchRequest = z.infer<typeof searchSchema>
export type WorkspaceSearchResult = SearchChunk & {
  origin: "workspace" | "dependency"; score: number; matchedTerms: string[]
  package: string | null; version: string | null; integrity: string | null
  projectRoot: string | null; dependencyRoots: string[]; kind: string; signature: string | null
}
type DependencyCoverage = Dependency & { status: "searched" | "missing-index" | "error"; reason?: string }

export async function workspaceSearch(input: SearchRequest, options: { signal?: AbortSignal } = {}) {
  const request = searchSchema.parse(input)
  if (!isAbsolute(request.workspaceRoot)) throw new Error("workspaceRoot must be an absolute path")
  const root = await realpath(request.workspaceRoot)
  const file = request.file ? resolve(root, isAbsolute(request.file) && inside(resolve(request.workspaceRoot), request.file) ? relative(resolve(request.workspaceRoot), request.file) : request.file) : undefined
  if (file && !inside(root, file)) throw new Error("file must be within workspaceRoot")
  const started = performance.now()
  const signal = AbortSignal.any([AbortSignal.timeout(request.timeoutMs ?? 60_000), ...(options.signal ? [options.signal] : [])])
  const scope = request.scope ?? "all"
  const inventory = await inventoryWorkspace(root, scope !== "workspace", signal)
  const candidates: WorkspaceSearchResult[] = []
  const indexed = scope === "dependencies" ? null : searchWorkspaceIndex(root, inventory.files, request.question, signal)
  const issues = [...inventory.issues, ...(indexed?.truncated.map(path => `File chunk limit reached: ${path}`) ?? [])]
  const projects = [...inventory.projects].sort((a, b) => b.length - a.length)
  for (const chunk of indexed?.candidates ?? []) {
    const rank = scoreCandidate(request.question, `${chunk.symbol ?? ""} ${relative(root, chunk.source)}`, chunk.snippet)
    if (!rank.score) continue
    const nearby = file && (chunk.source === file ? 8 : dirname(chunk.source) === dirname(file) ? 3 : 0)
    candidates.push({ ...chunk, ...rank, score: rank.score + (nearby || 0), origin: "workspace", package: null, version: null, integrity: null,
      projectRoot: projects.find(project => inside(project, chunk.source)) ?? root, dependencyRoots: [], kind: chunk.symbol ? "declaration" : "text", signature: null })
  }
  const dependencies: DependencyCoverage[] = []
  // Yield between packages so cancellation from an MCP client can be observed.
  for (const dependency of inventory.dependencies) {
    await new Promise<void>(resolve => setImmediate(resolve))
    signal.throwIfAborted()
    const path = brainPath(dependency.package, dependency.version)
    if (!existsSync(path)) { dependencies.push({ ...dependency, status: "missing-index", reason: `Prepare with typelatch add ${dependency.package}@${dependency.version}` }); continue }
    try {
      const db = openBrainDatabase(path)
      let integrity: string
      try {
        const metadata = Object.fromEntries((db.prepare("SELECT key,value FROM metadata").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]))
        if (metadata.package !== dependency.package || metadata.version !== dependency.version || !metadata.integrity) throw new Error("Index metadata does not match the exact dependency identity")
        if (dependency.integrity && metadata.integrity !== dependency.integrity) throw new Error("Index integrity does not match the lockfile artifact")
        integrity = metadata.integrity
      } finally { db.close() }
      const response = queryBrain(dependency.package, request.question, { version: dependency.version, limit: 20, recordUsage: false })
      dependencies.push({ ...dependency, status: "searched" })
      for (const item of response.results) {
        const rank = scoreCandidate(request.question, item.symbol, `${item.signature}\n${item.summary}`)
        if (!rank.score) continue
        candidates.push({ source: item.source, line: item.line, endLine: item.line, symbol: item.symbol, position: null,
          snippet: `${item.signature}\n${item.summary}`.slice(0, 2400), ...rank, origin: "dependency", package: dependency.package,
          version: dependency.version, integrity, projectRoot: null, dependencyRoots: dependency.roots.slice(0, 20), kind: item.kind, signature: item.signature.slice(0, 1600) })
      }
    } catch (error) { dependencies.push({ ...dependency, status: "error", reason: error instanceof Error ? error.message : String(error) }) }
  }
  candidates.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.line - b.line || (a.package ?? "").localeCompare(b.package ?? "") || (a.version ?? "").localeCompare(b.version ?? ""))
  const perSource = new Map<string, number>()
  const results: WorkspaceSearchResult[] = []
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.origin, candidate.source, candidate.package, candidate.version])
    if ((perSource.get(key) ?? 0) >= 2) continue
    if (results.some(item => item.origin === candidate.origin && item.source === candidate.source && item.package === candidate.package && item.version === candidate.version && (candidate.origin === "workspace" ? item.line <= candidate.endLine && candidate.line <= item.endLine : item.symbol === candidate.symbol))) continue
    perSource.set(key, (perSource.get(key) ?? 0) + 1)
    results.push(candidate)
    if (results.length >= (request.limit ?? 8)) break
  }
  const complete = issues.length === 0 && dependencies.every(item => item.status === "searched")
  const gapsFirst = [...dependencies].sort((a, b) => Number(a.status === "searched") - Number(b.status === "searched"))
  return {
    workspaceRoot: root, question: request.question, scope,
    status: !complete ? "partial" as const : results.length ? "ok" as const : "empty" as const,
    results, latencyMs: Math.round(performance.now() - started), index: indexed?.index ?? null,
    coverage: {
      complete, selection: inventory.selection, files: inventory.files.filter(file => file.searchable).length,
      projects: inventory.projects.slice(0, 100), configs: inventory.configs.slice(0, 100),
      projectsOmitted: Math.max(0, inventory.projects.length - 100), configsOmitted: Math.max(0, inventory.configs.length - 100),
      excluded: inventory.excluded.map(item => ({ ...item, path: relative(root, item.path) })), excludedCount: inventory.excludedCount,
      dependencies: gapsFirst.slice(0, 40).map(item => ({ ...item, roots: item.roots.slice(0, 20), rootsOmitted: Math.max(0, item.roots.length - 20) })),
      dependencyCount: dependencies.length, searchedDependencies: dependencies.filter(item => item.status === "searched").length,
      missingIndexes: dependencies.filter(item => item.status === "missing-index").length, dependencyErrors: dependencies.filter(item => item.status === "error").length,
      dependenciesOmitted: Math.max(0, dependencies.length - 40), issues: issues.slice(0, 40), issuesOmitted: Math.max(0, issues.length - 40),
      retrieval: { workspaceCandidateLimit: 400, workspaceCandidateLimitReached: indexed?.candidateLimitReached ?? false, perDependencyLimit: 20, exhaustive: false }
    },
    checks: {
      retrieved: { status: results.length ? "pass" : "unknown", reason: "Lexical candidates only; coverage and ranking limits remain explicit" },
      resolved: { status: "not-run", reason: "Use workspace_context for compiler resolution" },
      typechecked: { status: "not-run", reason: "Use workspace_validate for compilation" },
      tested: { status: "not-run", reason: "No assertion command executed" },
      stable: { status: "unknown", reason: "Search records files as read; it does not establish an atomic workspace snapshot" },
      artifactMatch: { status: "unknown", reason: "Installed dependency contents were not compared with registry artifacts" }
    },
    next: results.length ? "Inspect the returned source and symbol. Use workspace_context with a listed config and workspace file for resolution, then workspace_validate for compilation and explicitly authorized assertions." : "Inspect coverage gaps and refine the question or use file search. An empty shortlist does not establish absence."
  }
}
