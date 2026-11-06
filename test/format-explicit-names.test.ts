import { expect, it } from "vitest"
import { formatQuery } from "../src/format.js"
import type { QueryResponse, QueryResultItem } from "../src/types.js"

function item(symbol: string): QueryResultItem {
  return { symbol, kind: "const", module: "Schema", signature: "declared signature", summary: "Normalize a value.",
    source: "src/Schema.ts", line: 10, score: 100, confidence: "medium", signals: ["public API"], relationships: [] }
}

function response(fields: Partial<QueryResponse> = {}): QueryResponse {
  return { queryId: "fixture-query", package: "effect", version: "3.22.1", question: "Normalize a value", strategy: "hybrid",
    latencyMs: 1.25, results: [item("Schema.Trim")], fallback: null, ...fields }
}

const ordinaryText = `effect@3.22.1 · hybrid · 1.25 ms
Query ID: fixture-query

1. Schema.Trim [medium]
   Normalize a value.
   src/Schema.ts:10
   Evidence: public API

Record outcome: typelatch feedback fixture-query --accepted yes --compile pass --tests pass`

it("preserves ordinary and singular output byte for byte", () => {
  expect(formatQuery(response())).toBe(ordinaryText)
  expect(formatQuery(response({ strategy: "exact", question: "Schema.Trim", lookup: { status: "exact", matchedBy: "qualified-name", totalMatches: 1, omitted: 0 } })))
    .toBe(ordinaryText.replace("· hybrid ·", "· exact ·"))
})

it("preserves ordinary fallback and relationship formatting", () => {
  expect(formatQuery(response({ results: [], fallback: "Inspect installed source." }))).toBe(`effect@3.22.1 · hybrid · 1.25 ms
Query ID: fixture-query

Inspect installed source.

Record outcome: typelatch feedback fixture-query --accepted yes --compile pass --tests pass`)
  const result = item("Schema.Trim")
  result.relationships = [{ type: "references", target: "Schema.String" }]
  expect(formatQuery(response({ results: [result] }))).toBe(ordinaryText.replace("   Evidence: public API", "   Evidence: public API\n   Related: references → Schema.String"))
})

it("summarizes all exact compound names without repeating their positive identities", () => {
  const names = ["Schema.Trim", "Schema.filter"]
  const text = formatQuery(response({ results: names.map(item), requestedSymbols: names.map(symbol => ({ symbol, status: "exact" })) }))
  expect(text).toContain("Requested names: 2 of 2 returned")
  expect(text).not.toContain("Not found in local index")
  expect(text).not.toContain("Omitted by result limit")
  expect(text).not.toContain("Additional requested names not checked")
  for (const symbol of names) expect(text.split(symbol)).toHaveLength(2)
})

it("shows missing and case mismatched names as missing in the local index", () => {
  const text = formatQuery(response({ requestedSymbols: [
    { symbol: "Schema.Trim", status: "exact" },
    { symbol: "schema.Trim", status: "not-found" },
    { symbol: "Schema.Missing", status: "not-found" }
  ] }))
  expect(text).toContain("Requested names: 1 of 3 returned")
  expect(text).toContain("Not found in local index: schema.Trim, Schema.Missing")
  expect(text).not.toContain("Omitted by result limit")
})

it("distinguishes names excluded by the result limit from missing names", () => {
  const text = formatQuery(response({ requestedSymbols: [
    { symbol: "Schema.Trim", status: "exact" },
    { symbol: "Schema.filter", status: "omitted" },
    { symbol: "Schema.Struct", status: "omitted" }
  ] }))
  expect(text).toContain("Requested names: 1 of 3 returned")
  expect(text).toContain("Omitted by result limit: Schema.filter, Schema.Struct")
  expect(text).not.toContain("Not found in local index")
})

it("reports unchecked overflow beyond 64 separately from the checked result limit", () => {
  const names = Array.from({ length: 64 }, (_, index) => `Batch.Symbol${index}`)
  const text = formatQuery(response({ results: [item(names[0]!)], requestedSymbols: names.map((symbol, index) => ({ symbol, status: index === 0 ? "exact" : "omitted" })), requestedSymbolsTruncated: 3 }))
  expect(text).toContain("Requested names: 1 of 64 returned")
  expect(text).toContain(`Omitted by result limit: ${names.slice(1).join(", ")}`)
  expect(text).toContain("Additional requested names not checked: 3 (recognition limit: 64)")
  expect(text).not.toContain("Not found in local index")
})

it("keeps absent names visible when no results were returned", () => {
  const text = formatQuery(response({ results: [], requestedSymbols: [
    { symbol: "Schema.Missing", status: "not-found" },
    { symbol: "Schema.OtherMissing", status: "not-found" }
  ], fallback: "Inspect installed source." }))
  expect(text).toContain("Requested names: 0 of 2 returned")
  expect(text).toContain("Not found in local index: Schema.Missing, Schema.OtherMissing")
  expect(text).toContain("Inspect installed source.")
})
