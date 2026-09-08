import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { usagePath } from "./paths.js"
import type { QueryResponse } from "./types.js"

export type UsageStats = {
  queries: number
  hits: number
  misses: number
  hitRate: number
  averageLatencyMs: number
  exactQueries: number
  hybridQueries: number
  estimatedResultTokens: number
  outcomes: number
  accepted: number
  compilePasses: number
  testPasses: number
  recent: Array<{
    id: string
    timestamp: string
    package: string
    version: string
    question: string
    latencyMs: number
    resultCount: number
  }>
}

function openUsage(): Database.Database {
  const path = usagePath()
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      package TEXT NOT NULL,
      version TEXT NOT NULL,
      question TEXT NOT NULL,
      strategy TEXT NOT NULL,
      latency_ms REAL NOT NULL,
      result_count INTEGER NOT NULL,
      estimated_result_tokens INTEGER NOT NULL,
      result_symbols TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      query_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      accepted INTEGER,
      compile_passed INTEGER,
      tests_passed INTEGER,
      notes TEXT NOT NULL,
      FOREIGN KEY(query_id) REFERENCES queries(id)
    );
  `)
  return db
}

export function recordQuery(response: QueryResponse): void {
  const db = openUsage()
  try {
    const serialized = JSON.stringify(response.results)
    db.prepare(`
      INSERT INTO queries (
        id, timestamp, package, version, question, strategy, latency_ms,
        result_count, estimated_result_tokens, result_symbols
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      response.queryId,
      new Date().toISOString(),
      response.package,
      response.version,
      response.question,
      response.strategy,
      response.latencyMs,
      response.results.length,
      Math.ceil(serialized.length / 4),
      JSON.stringify(response.results.map((result) => result.symbol))
    )
  } finally {
    db.close()
  }
}

export function recordOutcome(
  queryId: string,
  outcome: { accepted?: boolean; compilePassed?: boolean; testsPassed?: boolean; notes?: string }
): void {
  const db = openUsage()
  try {
    const exists = db.prepare("SELECT 1 FROM queries WHERE id = ?").get(queryId)
    if (!exists) throw new Error(`Unknown query id: ${queryId}`)
    db.prepare(`
      INSERT OR REPLACE INTO outcomes (
        query_id, timestamp, accepted, compile_passed, tests_passed, notes
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      queryId,
      new Date().toISOString(),
      nullableBoolean(outcome.accepted),
      nullableBoolean(outcome.compilePassed),
      nullableBoolean(outcome.testsPassed),
      outcome.notes ?? ""
    )
  } finally {
    db.close()
  }
}

export function readStats(): UsageStats {
  const db = openUsage()
  try {
    const totals = db.prepare(`
      SELECT
        count(*) AS queries,
        sum(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) AS hits,
        sum(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS misses,
        coalesce(avg(latency_ms), 0) AS average_latency_ms,
        sum(CASE WHEN strategy = 'exact' THEN 1 ELSE 0 END) AS exact_queries,
        sum(CASE WHEN strategy = 'hybrid' THEN 1 ELSE 0 END) AS hybrid_queries,
        coalesce(sum(estimated_result_tokens), 0) AS estimated_result_tokens
      FROM queries
    `).get() as Record<string, number>
    const outcomes = db.prepare(`
      SELECT count(*) AS outcomes,
        coalesce(sum(accepted = 1), 0) AS accepted,
        coalesce(sum(compile_passed = 1), 0) AS compile_passes,
        coalesce(sum(tests_passed = 1), 0) AS test_passes
      FROM outcomes
    `).get() as Record<string, number>
    const recent = db.prepare(`
      SELECT id, timestamp, package, version, question, latency_ms, result_count
      FROM queries ORDER BY timestamp DESC LIMIT 10
    `).all() as Array<Record<string, string | number>>
    const queries = totals.queries ?? 0
    const hits = totals.hits ?? 0
    return {
      queries,
      hits,
      misses: totals.misses ?? 0,
      hitRate: queries === 0 ? 0 : hits / queries,
      averageLatencyMs: totals.average_latency_ms ?? 0,
      exactQueries: totals.exact_queries ?? 0,
      hybridQueries: totals.hybrid_queries ?? 0,
      estimatedResultTokens: totals.estimated_result_tokens ?? 0,
      outcomes: outcomes.outcomes ?? 0,
      accepted: outcomes.accepted ?? 0,
      compilePasses: outcomes.compile_passes ?? 0,
      testPasses: outcomes.test_passes ?? 0,
      recent: recent.map((row) => ({
        id: String(row.id),
        timestamp: String(row.timestamp),
        package: String(row.package),
        version: String(row.version),
        question: String(row.question),
        latencyMs: Number(row.latency_ms),
        resultCount: Number(row.result_count)
      }))
    }
  } finally {
    db.close()
  }
}

function nullableBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value)
}
