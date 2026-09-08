import { randomUUID } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import type Database from "better-sqlite3"
import { openBrainDatabase } from "./database.js"
import { brainPath, installedPackageDirectory } from "./paths.js"
import { recordQuery } from "./usage.js"
import type { BrainFormat, QueryResponse, QueryResultItem } from "./types.js"

type SymbolRow = {
  id: number
  qualified_name: string
  name: string
  kind: string
  module: string
  signature: string
  docs: string
  source_path: string
  line_start: number
  source: string
  is_public: number
  is_deprecated: number
  is_internal: number
  category: string | null
  example_count: number
  rank?: number
}

export type QueryOptions = {
  version?: string
  brainFile?: string
  limit?: number
  recordUsage?: boolean
}

export function queryBrain(packageName: string, question: string, options: QueryOptions = {}): QueryResponse {
  const version = options.version ?? latestInstalledVersion(packageName)
  const path = options.brainFile ?? brainPath(packageName, version)
  const db = openBrainDatabase(path)
  const started = performance.now()
  try {
    const format = brainFormat(db)
    const strategy = looksExact(question) ? "exact" : "hybrid"
    const rows = strategy === "exact"
      ? exactRows(db, extractSymbolCandidate(question), options.limit ?? 5, format)
      : hybridRows(db, question, options.limit ?? 5, format)
    const relationships = relationshipsForRows(db, rows, format)
    const results = rows.map((row, index) => resultFromRow(row, index, relationships.get(row.qualified_name) ?? []))
    const response: QueryResponse = {
      queryId: randomUUID(),
      package: packageName,
      version,
      question,
      strategy,
      latencyMs: round(performance.now() - started),
      results,
      fallback: results.length === 0
        ? `No confident local result. Inspect the installed ${packageName}@${version} source.`
        : null
    }
    if (options.recordUsage !== false && process.env.APIROVA_USAGE !== "off") recordQuery(response)
    return response
  } finally {
    db.close()
  }
}

export function getSymbol(packageName: string, symbol: string, options: QueryOptions = {}): QueryResponse {
  const version = options.version ?? latestInstalledVersion(packageName)
  const db = openBrainDatabase(options.brainFile ?? brainPath(packageName, version))
  const started = performance.now()
  try {
    const format = brainFormat(db)
    const rows = exactRows(db, symbol, options.limit ?? 10, format)
    const relationships = relationshipsForRows(db, rows, format)
    const response: QueryResponse = {
      queryId: randomUUID(),
      package: packageName,
      version,
      question: symbol,
      strategy: "exact",
      latencyMs: round(performance.now() - started),
      results: rows.map((row, index) => resultFromRow(row, index, relationships.get(row.qualified_name) ?? [])),
      fallback: rows.length === 0 ? `Symbol ${symbol} was not found in ${packageName}@${version}.` : null
    }
    if (options.recordUsage !== false && process.env.APIROVA_USAGE !== "off") recordQuery(response)
    return response
  } finally {
    db.close()
  }
}

function exactRows(db: Database.Database, candidate: string, limit: number, format: BrainFormat): SymbolRow[] {
  const bare = candidate.split(".").at(-1) ?? candidate
  if (format === "trimmed") {
    return db.prepare(`
      SELECT s.id, n.qualified_name, s.name, s.kind, s.module, s.signature, s.docs,
        s.source_path, s.line_start, '' AS source,
        s.is_public, s.is_deprecated, s.is_internal, s.category, s.example_count
      FROM symbols s
      JOIN nodes n ON n.id = s.id
      WHERE n.qualified_name = ? COLLATE NOCASE OR s.name = ? COLLATE NOCASE
      ORDER BY
        CASE
          WHEN n.qualified_name = ? THEN 0
          WHEN s.name = ? THEN 1
          WHEN n.qualified_name = ? COLLATE NOCASE THEN 2
          WHEN s.name = ? COLLATE NOCASE THEN 3
          ELSE 4
        END,
        s.is_public DESC, s.is_deprecated ASC, length(n.qualified_name), n.qualified_name
      LIMIT ?
    `).all(candidate, bare, candidate, bare, candidate, bare, limit) as SymbolRow[]
  }
  return db.prepare(`
    SELECT * FROM symbols
    WHERE qualified_name = ? COLLATE NOCASE OR name = ? COLLATE NOCASE
      ORDER BY
        CASE
          WHEN qualified_name = ? THEN 0
          WHEN name = ? THEN 1
          WHEN qualified_name = ? COLLATE NOCASE THEN 2
          WHEN name = ? COLLATE NOCASE THEN 3
          ELSE 4
        END,
        is_public DESC, is_deprecated ASC, length(qualified_name), qualified_name
      LIMIT ?
  `).all(candidate, bare, candidate, bare, candidate, bare, limit) as SymbolRow[]
}

function hybridRows(db: Database.Database, question: string, limit: number, format: BrainFormat): SymbolRow[] {
  const tokens = searchTokens(question)
  if (tokens.length === 0) return []
  const fts = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ")
  const candidates = (format === "trimmed"
    ? db.prepare(`
        SELECT s.id, n.qualified_name, s.name, s.kind, s.module, s.signature, s.docs,
          s.source_path, s.line_start, '' AS source,
          s.is_public, s.is_deprecated, s.is_internal, s.category, s.example_count,
          bm25(symbol_search, 7.0, 2.0, 1.0) AS rank
        FROM symbol_search
        JOIN symbols s ON s.id = symbol_search.rowid
        JOIN nodes n ON n.id = s.id
        WHERE symbol_search MATCH ?
        ORDER BY rank ASC, n.qualified_name
        LIMIT ?
      `).all(fts, Math.max(limit * 20, 80))
    : db.prepare(`
        SELECT s.*, bm25(symbol_search, 7.0, 2.0, 1.0) AS rank
        FROM symbol_search
        JOIN symbols s ON s.id = symbol_search.rowid
        WHERE symbol_search MATCH ?
        ORDER BY rank ASC, s.qualified_name
        LIMIT ?
      `).all(fts, Math.max(limit * 20, 80))) as SymbolRow[]
  const variants = new Map<string, number>()
  return candidates
    .map((row) => ({ row, relevance: relevance(row, tokens, question) }))
    .sort((left, right) =>
      right.relevance - left.relevance ||
      (left.row.rank ?? 0) - (right.row.rank ?? 0) ||
      compareQualifiedNames(left.row.qualified_name, right.row.qualified_name)
    )
    .filter(({ row }) => {
      // Preserve the common import/require pair, but prevent additional
      // browser/node copies of the same API shape consuming the shortlist.
      // This is diversity, not a claim of artifact or semantic equivalence.
      const key = JSON.stringify([row.name, row.kind, row.signature.replace(/\s+/g, " ")])
      const count = variants.get(key) ?? 0
      variants.set(key, count + 1)
      return count < 2
    })
    .slice(0, limit)
    .map(({ row }) => row)
}

// Total, format-independent tie-break so equal relevance and equal bm25 rank
// order identically no matter which storage format (and query plan) produced
// the candidate pool.
function compareQualifiedNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function relevance(row: SymbolRow, tokens: string[], question: string): number {
  const name = row.name.toLowerCase()
  const qualified = row.qualified_name.toLowerCase()
  // Source locations and link destinations are provenance, not API behavior.
  const docs = row.docs.replace(/\[(?:Member|Referenced type|Re-export target|README) [^\]]*\]/g, "")
    .replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "").toLowerCase()
  const signature = row.signature.toLowerCase()
  let score = row.is_public ? 10 : -10
  // For behavioral requests, a callable API is preferable to an
  // equally relevant supporting type. Explicit type/configuration questions
  // retain the neutral ordering.
  if (!/\b(type|types|interface|options?|settings|configuration)\b/i.test(question) && (["class", "function"].includes(row.kind) || /(?:^|[;{]\s*)\([^)]*\)\s*:/.test(row.signature) || (row.kind === "const" && /:\s*(?:<[^>]+>\s*)?\(/.test(row.signature)))) score += 18
  if (row.is_deprecated) score -= 35
  if (row.is_internal) score -= 25
  // Prefer non-vendored candidates when similarly relevant. This is a ranking
  // heuristic, not a visibility claim; public re-exports remain separate.
  if (/(?:^|\/)vendor(?:\/|$)/.test(row.module)) score -= 35
  const words = new Set(row.name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).map(searchStem))
  // A request to create an object favors its declared constructor over the
  // option/type names that merely describe it. No package names are involved.
  if (/\b(create|instantiate|construct)\b/i.test(question) && (row.kind === "class" || /:\s*new\s*\(/.test(row.signature))) score += /\b(independent|instance|object)\b/i.test(question) ? 50 : 30
  if (row.example_count > 0) score += Math.min(6, row.example_count)
  for (const token of tokens) {
    if (name === token) score += 30
    else if (name.includes(token)) score += 18
    if (!name.includes(token) && words.has(searchStem(token))) score += 18
    if (qualified.includes(token)) score += 8
    if (docs.includes(token)) score += 7
    if (signature.includes(token)) score += 4
  }
  return score
}

function searchStem(word: string): string {
  return word.replace(/ies$/, "y").replace(/(?:ing|ed|s)$/, "").replace(/e$/, "")
}

function resultFromRow(
  row: SymbolRow,
  index: number,
  relationships: Array<{ type: string; target: string }>
): QueryResultItem {
  const signals: string[] = []
  if (row.is_public) signals.push("public API")
  if (row.docs.length > 0) signals.push("documented")
  if (row.example_count > 0) signals.push(`${row.example_count} documentation example${row.example_count === 1 ? "" : "s"}`)
  if (row.is_deprecated) signals.push("deprecated")
  if (row.is_internal) signals.push("internal")
  const confidence = row.is_public && !row.is_deprecated && row.docs.length > 80
    ? "high"
    : row.is_public && !row.is_deprecated
      ? "medium"
      : "low"
  return {
    symbol: row.qualified_name,
    kind: row.kind,
    module: row.module,
    signature: row.signature,
    summary: summarize(row.docs),
    source: row.source_path,
    line: row.line_start,
    score: Math.max(1, 100 - index * 8),
    confidence,
    signals,
    relationships
  }
}

function relationshipsForRows(
  db: Database.Database,
  symbols: SymbolRow[],
  format: BrainFormat
): Map<string, Array<{ type: string; target: string }>> {
  const grouped = new Map<string, Array<{ type: string; target: string }>>()
  if (symbols.length === 0) return grouped
  const placeholders = symbols.map(() => "?").join(", ")
  const rows = format !== "baseline"
    ? db.prepare(`
        SELECT e.from_id AS source_id,
          CASE e.type
            WHEN 1 THEN 'accepts'
            WHEN 2 THEN 'returns'
            WHEN 3 THEN 'references'
            WHEN 4 THEN 'delegates_to'
            WHEN 5 THEN 're_exports'
          END AS type,
          target.qualified_name AS target
        FROM edges e
        JOIN nodes target ON target.id = e.to_id
        WHERE e.from_id IN (${placeholders})
        ORDER BY e.from_id, CASE e.type WHEN 4 THEN 0 ELSE 1 END, target.qualified_name
      `).all(...symbols.map((symbol) => symbol.id)).map((row) => {
        const typed = row as { source_id: number; type: string; target: string }
        return {
          source: symbols.find((symbol) => symbol.id === typed.source_id)?.qualified_name ?? "",
          type: typed.type,
          target: typed.target
        }
      }) as Array<{ source: string; type: string; target: string }>
    : db.prepare(`
        SELECT from_symbol AS source, type, to_symbol AS target
        FROM edges
        WHERE from_symbol IN (${placeholders})
        ORDER BY from_symbol, CASE type WHEN 'delegates_to' THEN 0 ELSE 1 END, to_symbol
      `).all(...symbols.map((symbol) => symbol.qualified_name)) as Array<{ source: string; type: string; target: string }>
  for (const row of rows) {
    const group = grouped.get(row.source) ?? []
    if (group.length < 12) group.push({ type: row.type, target: row.target })
    grouped.set(row.source, group)
  }
  return grouped
}

function brainFormat(db: Database.Database): BrainFormat {
  const stored = db.prepare("SELECT value FROM metadata WHERE key = 'format'").get() as { value: string } | undefined
  if (stored && !["baseline", "compact", "trimmed"].includes(stored.value)) throw new Error(`Unsupported brain format ${stored.value}; rebuild with this Apirova version`)
  const schema = db.prepare("SELECT value FROM metadata WHERE key = 'schemaVersion'").get() as { value: string } | undefined
  const version = Number(schema?.value ?? 1)
  if (![1, 2, 3].includes(version)) throw new Error(`Unsupported brain schema ${version}; rebuild with this Apirova version`)
  if (stored?.value === "trimmed") return "trimmed"
  if (stored?.value === "compact") return "compact"
  if (version >= 3) return "trimmed"
  return version >= 2 ? "compact" : "baseline"
}

function searchTokens(question: string): string[] {
  const stop = new Set(["a", "an", "and", "are", "do", "for", "how", "i", "in", "is", "it", "of", "should", "the", "to", "use", "with", "what", "which", "can", "that", "when", "such", "as", "or", "on", "at", "this", "my", "be", "by", "its", "each"])
  const original = [...new Set(question.toLowerCase().match(/[a-z_$][a-z0-9_$]{1,}|\d+/g) ?? [])]
    .filter((token) => !stop.has(token))
  const expansions: Record<string, string[]> = {
    backoff: ["retry", "delay", "exponential"],
    dependency: ["service", "layer", "context", "provide"],
    dependencies: ["service", "layer", "context", "provide"],
    validate: ["decode", "schema", "parse"],
    validation: ["decode", "schema", "parse"],
    cleanup: ["acquire", "release", "scope"],
    parallel: ["concurrency", "all"],
    sequentially: ["all", "concurrency"]
  }
  return [...new Set(original.flatMap((token) => {
    const expansion = Object.hasOwn(expansions, token) ? expansions[token] : undefined
    return [token, ...(expansion ?? [])]
  }))].slice(0, 16)
}

function looksExact(question: string): boolean {
  const trimmed = question.trim()
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(trimmed) ||
    /\b(where|find|locate)\b.*\b(defined|symbol|declaration)\b/i.test(trimmed)
}

function extractSymbolCandidate(question: string): string {
  const dotted = question.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+/)?.[0]
  if (dotted) return dotted
  const quoted = question.match(/[`'"]([A-Za-z_$][\w$]*)[`'"]/)?.[1]
  return quoted ?? question.trim().split(/\s+/).at(-1)?.replace(/[^A-Za-z0-9_$.]/g, "") ?? question
}

function summarize(docs: string): string {
  if (!docs) return "No documentation summary was present in the package artifact."
  const withoutTags = docs.split("\n").filter((line) => !line.trimStart().startsWith("@")).join("\n")
  const paragraph = withoutTags.split(/\n\s*\n/).find((part) => !part.trimStart().startsWith("```")) ?? withoutTags
  return paragraph.replace(/\s+/g, " ").trim().slice(0, 600)
}

export function latestInstalledVersion(packageName: string): string {
  const parent = installedPackageDirectory(packageName)
  if (!existsSync(parent)) throw new Error(`No brain installed for ${packageName}. Run: apirova add ${packageName}`)
  const versions = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(parent, entry.name, "brain.db")))
    .map((entry) => entry.name)
    .sort(compareVersions)
  const latest = versions.at(-1)
  if (!latest) throw new Error(`No brain installed for ${packageName}. Run: apirova add ${packageName}`)
  return latest
}

function compareVersions(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
