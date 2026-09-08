import type { BrainMetadata, QueryResponse } from "./types.js"
import type { UsageStats } from "./usage.js"

export function formatMetadata(metadata: BrainMetadata, path: string): string {
  const ratio = metadata.sourceBytes === 0 ? 0 : metadata.brainBytes / metadata.sourceBytes
  return [
    `Installed ${metadata.package}@${metadata.version}`,
    `Format: ${metadata.format} · schema v${metadata.schemaVersion}`,
    `Brain: ${path}`,
    `Source: ${formatBytes(metadata.sourceBytes)} → brain: ${formatBytes(metadata.brainBytes)} (${(ratio * 100).toFixed(1)}%)`,
    `${metadata.symbols.toLocaleString()} symbols (${metadata.publicSymbols.toLocaleString()} public), ${metadata.relationships.toLocaleString()} relationships`,
    `${metadata.examples.toLocaleString()} documentation examples, ${metadata.deprecatedSymbols.toLocaleString()} deprecated APIs`,
    `Integrity: ${metadata.integrity}`
  ].join("\n")
}

export function formatQuery(response: QueryResponse): string {
  const lines = [
    `${response.package}@${response.version} · ${response.strategy} · ${response.latencyMs} ms`,
    `Query ID: ${response.queryId}`
  ]
  if (response.fallback) lines.push("", response.fallback)
  for (const [index, result] of response.results.entries()) {
    lines.push(
      "",
      `${index + 1}. ${result.symbol} [${result.confidence}]`,
      `   ${result.summary}`,
      `   ${result.source}:${result.line}`,
      `   Evidence: ${result.signals.join(", ") || "source declaration only"}`
    )
    if (result.relationships.length > 0) {
      lines.push(`   Related: ${result.relationships.slice(0, 6).map((edge) => `${edge.type} → ${edge.target}`).join("; ")}`)
    }
  }
  lines.push("", `Record outcome: typelatch feedback ${response.queryId} --accepted yes --compile pass --tests pass`)
  return lines.join("\n")
}

export function formatStats(stats: UsageStats): string {
  const lines = [
    "Local Typelatch usage",
    `Queries: ${stats.queries} · hits: ${stats.hits} · misses: ${stats.misses} · hit rate: ${(stats.hitRate * 100).toFixed(1)}%`,
    `Average retrieval latency: ${stats.averageLatencyMs.toFixed(2)} ms`,
    `Strategies: ${stats.exactQueries} exact · ${stats.hybridQueries} hybrid`,
    `Estimated result context: ${stats.estimatedResultTokens.toLocaleString()} tokens`,
    `Outcomes recorded: ${stats.outcomes} · accepted: ${stats.accepted} · compile passes: ${stats.compilePasses} · test passes: ${stats.testPasses}`
  ]
  if (stats.recent.length > 0) {
    lines.push("", "Recent queries:")
    for (const query of stats.recent) {
      lines.push(`- ${query.package}@${query.version} · ${query.latencyMs} ms · ${query.resultCount} results · ${query.question}`)
    }
  }
  lines.push("", "All statistics stay in ~/.typelatch/usage.db; nothing is uploaded.")
  return lines.join("\n")
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
