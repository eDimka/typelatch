export type PackageIdentity = {
  name: string
  version: string
  integrity: string
  tarballUrl: string
}

export type BrainFormat = "baseline" | "compact" | "trimmed"

export type SymbolRecord = {
  qualifiedName: string
  name: string
  kind: string
  module: string
  signature: string
  docs: string
  sourcePath: string
  lineStart: number
  lineEnd: number
  source: string
  isPublic: boolean
  isDeprecated: boolean
  isInternal: boolean
  category: string | null
  exampleCount: number
}

export type EdgeRecord = {
  fromQualifiedName: string
  toQualifiedName: string
  type: "accepts" | "returns" | "references" | "delegates_to" | "re_exports"
  evidence: string
}

export type QueryResultItem = {
  symbol: string
  kind: string
  module: string
  signature: string
  summary: string
  source: string
  line: number
  score: number
  confidence: "high" | "medium" | "low"
  signals: string[]
  relationships: Array<{ type: string; target: string }>
}

export type QueryResponse = {
  queryId: string
  package: string
  version: string
  question: string
  strategy: "exact" | "hybrid"
  latencyMs: number
  results: QueryResultItem[]
  fallback: string | null
  lookup?: {
    status: "exact" | "ambiguous" | "not-found"
    matchedBy: "qualified-name" | "bare-name" | null
    totalMatches: number
    omitted: number
  }
}

export type BrainMetadata = {
  schemaVersion: number
  format: BrainFormat
  package: string
  version: string
  integrity: string
  generatedAt: string
  generator: string
  sourceBytes: number
  brainBytes: number
  files: number
  symbols: number
  publicSymbols: number
  relationships: number
  examples: number
  deprecatedSymbols: number
  internalSymbols: number
}
