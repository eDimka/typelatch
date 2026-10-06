import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { buildBrain } from "../dist/indexer.js"
import { prepareBaseline } from "./competitive-baseline.mjs"

const option = name => process.argv[process.argv.indexOf(name) + 1]
const root = process.cwd()
const candidate = resolve("dist")
const output = resolve(process.argv.includes("--out") ? option("--out") : "artifacts/competitive/usability")
const data = join(output, "data")
mkdirSync(output, { recursive: true })
const baselineBuild = process.argv.includes("--baseline") ? null : prepareBaseline(output)
const baseline = baselineBuild?.distDirectory ?? resolve(option("--baseline"))
const fixtures = [
  { package: "effect", version: "3.22.1", symbol: "Effect.retry", bare: "retry" },
  { package: "kysely", version: "0.28.8", symbol: "esm/kysely.TransactionBuilder", bare: "TransactionBuilder" }
]
const hash = value => createHash("sha256").update(value).digest("hex")
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8")
const inventories = []
for (const fixture of fixtures) {
  const target = join(data, "brains", fixture.package, fixture.version, "brain.db")
  if (!existsSync(target)) {
    const cached = join(root, ".typelatch", "brains", fixture.package, fixture.version, "brain.db")
    if (existsSync(cached)) { mkdirSync(dirname(target), { recursive: true }); cpSync(cached, target) }
    else await buildBrain(`${fixture.package}@${fixture.version}`, { output: target, onProgress: phase => console.error(`${fixture.package}: ${phase}`) })
  }
  const db = new Database(target, { readonly: true })
  try {
    const metadata = Object.fromEntries(db.prepare("SELECT key,value FROM metadata").all().map(row => [row.key, row.value]))
    assert.equal(metadata.package, fixture.package)
    assert.equal(metadata.version, fixture.version)
    assert.ok(metadata.integrity)
    inventories.push({ package: fixture.package, version: fixture.version, integrity: metadata.integrity, format: metadata.format, path: target, sha256: hash(readFileSync(target)) })
  } finally { db.close() }
}
const requests = fixtures.flatMap(fixture => [
  { label: `${fixture.package}:qualified`, kind: "qualified", name: "library_symbol", arguments: { package: fixture.package, version: fixture.version, symbol: fixture.symbol } },
  { label: `${fixture.package}:bare`, kind: "bare", name: "library_symbol", arguments: { package: fixture.package, version: fixture.version, symbol: fixture.bare } },
  { label: `${fixture.package}:missing-module`, kind: "missing", name: "library_symbol", arguments: { package: fixture.package, version: fixture.version, symbol: `never-present/module.${fixture.bare}` } },
  { label: `${fixture.package}:wrong-case`, kind: "missing", name: "library_symbol", arguments: { package: fixture.package, version: fixture.version, symbol: fixture.symbol.toUpperCase() } }
])

async function capture(directory, label) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(directory, "mcp.js")], cwd: root, env: { ...process.env, TYPELATCH_HOME: data, TYPELATCH_USAGE: "off" }, stderr: "pipe" })
  const client = new Client({ name: "typelatch-usability-proof", version: "1.0.0" })
  const records = []
  try {
    await client.connect(transport)
    for (const request of requests) {
      const started = performance.now()
      const response = await client.callTool({ name: request.name, arguments: request.arguments })
      assert.notEqual(response.isError, true)
      const content = response.structuredContent
      assert.ok(content)
      records.push({ request, response, elapsedMs: performance.now() - started, responseJsonUtf8Bytes: bytes(response), textContentUtf8Bytes: Buffer.byteLength(response.content.filter(item => item.type === "text").map(item => item.text).join("")), resultCount: content.results.length })
    }
  } finally { await client.close() }
  const recording = { generatedAt: new Date().toISOString(), server: directory, queryModuleSha256: hash(readFileSync(join(directory, "query.js"))), records }
  writeFileSync(join(output, `${label}-mcp.json`), JSON.stringify(recording, null, 2) + "\n")
  return recording
}

const before = await capture(baseline, "before")
const after = await capture(candidate, "after")
const comparisons = before.records.map((record, index) => {
  const next = after.records[index]
  const old = record.response.structuredContent
  const updated = next.response.structuredContent
  assert.equal(updated.package, old.package)
  assert.equal(updated.version, old.version)
  if (record.request.kind === "qualified") {
    assert.equal(updated.results.length, 1)
    assert.deepEqual(updated.results[0], old.results.find(item => item.symbol === record.request.arguments.symbol))
    assert.equal(updated.lookup.status, "exact")
  } else if (record.request.kind === "missing") {
    assert.equal(updated.results.length, 0)
    assert.equal(updated.lookup.status, "not-found")
    assert.ok(updated.fallback)
  } else {
    assert.equal(updated.lookup.status, "ambiguous")
    assert.ok(updated.lookup.totalMatches > 1)
  }
  return { label: record.request.label, kind: record.request.kind, beforeResults: record.resultCount, afterResults: next.resultCount,
    beforeResponseJsonUtf8Bytes: record.responseJsonUtf8Bytes, afterResponseJsonUtf8Bytes: next.responseJsonUtf8Bytes,
    responseBytesReduction: 1 - next.responseJsonUtf8Bytes / record.responseJsonUtf8Bytes, lookup: updated.lookup }
})
const report = {
  generatedAt: new Date().toISOString(), node: process.version,
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  baselineRef: baselineBuild?.ref ?? null,
  method: "Actual SDK client calls to two stdio MCP servers sharing identical local package indexes. Response bytes are UTF8 JSON serialization of each returned MCP CallToolResult including both content and structuredContent; they exclude transport framing. No model tokenizer or autonomous agent coding trial was run.",
  assertions: "Qualified lookup preserves all fields of the requested result; missing module and case remain not-found; bare names expose ambiguity. Each request still uses one tool call.",
  inventories, baselineQueryModuleSha256: before.queryModuleSha256, candidateQueryModuleSha256: after.queryModuleSha256,
  comparisons, passed: true
}
const { gzipSync } = await import("node:zlib")
const raw = gzipSync(JSON.stringify({ before, after }))
writeFileSync(join(output, "evidence.json.gz"), raw)
report.rawArchive = { path: "artifacts/competitive/usability/evidence.json.gz", bytes: raw.length, sha256: hash(raw) }
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
mkdirSync(join(root, "docs/benchmarks"), { recursive: true })
writeFileSync(join(root, "docs/benchmarks/usability.json"), JSON.stringify(report, null, 2) + "\n")
console.log(JSON.stringify({ passed: report.passed, comparisons }, null, 2))
