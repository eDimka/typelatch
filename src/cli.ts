#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { formatBenchmark, runBenchmark, type BenchmarkReport } from "./benchmark.js"
import { caseFilePath, corpusCaseFile, hasCorpusCases, loadCorpus } from "./benchmark/corpus.js"
import { buildBrain } from "./indexer.js"
import { formatMetadata, formatQuery, formatStats } from "./format.js"
import { brainPath } from "./paths.js"
import { exactProjectVersion, projectDependencies } from "./project.js"
import { getSymbol, queryBrain } from "./query.js"
import { readStats, recordOutcome } from "./usage.js"

import { workspaceContextAsync } from "./workspace/runtime.js"
import { validateWorkspace } from "./workspace/validate.js"
import { contextSchema, validationSchema } from "./workspace/schema.js"
import { runSupport } from "./support.js"

const [command = "help", ...args] = process.argv.slice(2)

try {
  switch (command) {
    case "support": {
      const report = await runSupport(positional(args)[0] ?? "examples/support/manifest.json", positional(args)[1] ?? "docs/benchmarks/support.json", message => console.error(`→ ${message}`))
      console.log(JSON.stringify({ passed: report.passed, navigationPassed: report.navigationPassed, totals: report.totals }, null, 2))
      const requiredGate = stringFlag(args, "--gate") ?? "discovery"
      if (!["discovery", "navigation"].includes(requiredGate)) throw new Error("--gate must be discovery or navigation")
      if (!(requiredGate === "navigation" ? report.navigationPassed : report.passed)) process.exitCode = 2
      break
    }
    case "workspace": {
      if (!args[0]) throw new Error("Usage: apirova workspace <request.json>")
      console.log(JSON.stringify(await workspaceContextAsync(contextSchema.parse(JSON.parse(readFileSync(args[0], "utf8")))), null, 2))
      break
    }
    case "validate": {
      if (!args[0]) throw new Error("Usage: apirova validate <request.json>")
      const request = validationSchema.parse(JSON.parse(readFileSync(args[0], "utf8")))
      const result = await validateWorkspace(request)
      console.log(JSON.stringify(result, null, 2))
      if ((request.testCommand && !result.success) || result.checks.typechecked.status !== "pass" || result.checks.stable.status !== "pass") process.exitCode = 2
      break
    }
    case "add":
    case "build":
      await addCommand(args)
      break
    case "sync":
      await syncCommand(args)
      break
    case "query":
      queryCommand(args)
      break
    case "symbol":
      symbolCommand(args)
      break
    case "stats":
      statsCommand(args)
      break
    case "feedback":
      feedbackCommand(args)
      break
    case "benchmark":
      benchmarkCommand(args)
      break
    case "help":
    case "--help":
    case "-h":
      printHelp()
      break
    default:
      throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(`apirova: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function addCommand(args: string[]): Promise<void> {
  const requested = positional(args)[0]
  if (!requested) throw new Error("Usage: apirova add <package[@version]>")
  let spec = requested
  if (!hasExplicitVersion(requested)) {
    const exact = await exactProjectVersion(process.cwd(), requested).catch(() => null)
    if (exact) spec = `${requested}@${exact}`
  }
  const result = await buildBrain(spec, { onProgress: (phase) => console.error(`→ ${phase}`) })
  console.log(formatMetadata(result.metadata, result.path))
}

async function syncCommand(args: string[]): Promise<void> {
  const selected = positional(args)
  const dependencies = await projectDependencies(process.cwd())
  const targets = selected.length === 0
    ? dependencies
    : dependencies.filter((dependency) => selected.includes(dependency.name))
  if (targets.length === 0) throw new Error("No matching locked dependencies found")
  for (const dependency of targets) {
    const path = brainPath(dependency.name, dependency.version)
    if (existsSync(path) && !flag(args, "--force")) {
      console.log(`✓ ${dependency.name}@${dependency.version} already installed`)
      continue
    }
    const result = await buildBrain(`${dependency.name}@${dependency.version}`, {
      onProgress: (phase) => console.error(`→ ${dependency.name}: ${phase}`)
    })
    console.log(`✓ ${result.metadata.package}@${result.metadata.version} · ${result.metadata.symbols} symbols`)
  }
}

function queryCommand(args: string[]): void {
  const values = positional(args)
  const packageSpec = values[0]
  const question = values.slice(1).join(" ")
  if (!packageSpec || !question) throw new Error('Usage: apirova query <package[@version]> "<question>"')
  const parsed = parseInstalledSpec(packageSpec)
  const response = queryBrain(parsed.name, question, {
    ...(parsed.version ? { version: parsed.version } : {}),
    limit: numberFlag(args, "--limit") ?? 5
  })
  console.log(flag(args, "--json") ? JSON.stringify(response, null, 2) : formatQuery(response))
}

function symbolCommand(args: string[]): void {
  const values = positional(args)
  const packageSpec = values[0]
  const name = values[1]
  if (!packageSpec || !name) throw new Error("Usage: apirova symbol <package[@version]> <symbol>")
  const parsed = parseInstalledSpec(packageSpec)
  const response = getSymbol(parsed.name, name, {
    ...(parsed.version ? { version: parsed.version } : {}),
    limit: numberFlag(args, "--limit") ?? 10
  })
  console.log(flag(args, "--json") ? JSON.stringify(response, null, 2) : formatQuery(response))
}

function statsCommand(args: string[]): void {
  const stats = readStats()
  console.log(flag(args, "--json") ? JSON.stringify(stats, null, 2) : formatStats(stats))
}

function feedbackCommand(args: string[]): void {
  const queryId = positional(args)[0]
  if (!queryId) throw new Error("Usage: apirova feedback <query-id> [--accepted yes|no] [--compile pass|fail] [--tests pass|fail]")
  const notes = stringFlag(args, "--notes")
  recordOutcome(queryId, {
    ...booleanFlag(args, "--accepted", "yes", "no", "accepted"),
    ...booleanFlag(args, "--compile", "pass", "fail", "compilePassed"),
    ...booleanFlag(args, "--tests", "pass", "fail", "testsPassed"),
    ...(notes ? { notes } : {})
  })
  console.log(`Outcome recorded for ${queryId}`)
}

function benchmarkCommand(args: string[]): void {
  if (flag(args, "--all")) {
    benchmarkAllCommand(args)
    return
  }
  const packageSpec = positional(args)[0] ?? "effect"
  const parsed = parseInstalledSpec(packageSpec)
  const cases = corpusCaseFile(parsed.name)
  const report = runBenchmark(parsed.name, cases, { ...(parsed.version ? { version: parsed.version } : {}) })
  console.log(flag(args, "--json") ? JSON.stringify(report, null, 2) : formatBenchmark(report))
  if (report.taskPassRate < 1) process.exitCode = 2
}

function benchmarkAllCommand(args: string[]): void {
  const corpus = loadCorpus()
  const reports: BenchmarkReport[] = []
  const skipped: Array<{ package: string; reason: string }> = []
  let failures = 0
  for (const entry of corpus.packages) {
    if (!hasCorpusCases(entry.name)) {
      const reason = `no case file at ${caseFilePath(entry.name)}`
      console.error(`→ Skipping ${entry.name}: ${reason}`)
      skipped.push({ package: entry.name, reason })
      failures++
      continue
    }
    try {
      const cases = corpusCaseFile(entry.name)
      const report = runBenchmark(entry.name, cases, { version: entry.version })
      reports.push(report)
      console.error(`→ ${entry.name}@${entry.version}: ${(report.taskPassRate * 100).toFixed(1)}% task pass`)
    } catch (error) {
      failures++
      console.error(`✗ ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.log(flag(args, "--json") ? JSON.stringify({ reports, skipped }, null, 2) : reports.map((report) => `${formatBenchmark(report)}\n`).join("\n"))
  if (failures > 0 || reports.some((report) => report.taskPassRate < 1)) process.exitCode = 2
}

function printHelp(): void {
  console.log(`Apirova: local API evidence for TypeScript agents

Usage:
  apirova add <package[@version]>
  apirova sync [package ...] [--force]
  apirova query <package[@version]> <question> [--json] [--limit N]
  apirova symbol <package[@version]> <symbol> [--json]
  apirova workspace <request.json>
  apirova validate <request.json>
  apirova feedback <queryId> [--accepted yes|no] [--compile pass|fail] [--tests pass|fail] [--notes text]
  apirova stats [--json]
  apirova benchmark [package@version] [--json]
  apirova benchmark --all [--json]
  apirova support [manifest.json] [report.json] [--gate discovery|navigation]

MCP server:
  apirova-mcp

Data stays local in ~/.apirova. See docs/USAGE.md for configuration.`)
}

function positional(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (!value) continue
    if (value.startsWith("--")) {
      if (!["--json", "--force", "--all"].includes(value)) index++
    } else values.push(value)
  }
  return values
}

function flag(args: string[], name: string): boolean {
  return args.includes(name)
}

function stringFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function numberFlag(args: string[], name: string): number | undefined {
  const raw = stringFlag(args, name)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) throw new Error(`${name} must be an integer from 1 to 50`)
  return parsed
}

function booleanFlag(
  args: string[],
  flagName: string,
  truthy: string,
  falsy: string,
  property: "accepted" | "compilePassed" | "testsPassed"
): Partial<Record<typeof property, boolean>> {
  const raw = stringFlag(args, flagName)
  if (raw === undefined) return {}
  if (raw !== truthy && raw !== falsy) throw new Error(`${flagName} must be ${truthy} or ${falsy}`)
  return { [property]: raw === truthy }
}

function hasExplicitVersion(spec: string): boolean {
  return spec.startsWith("@") ? spec.lastIndexOf("@") > 0 : spec.includes("@")
}

function parseInstalledSpec(spec: string): { name: string; version?: string } {
  const separator = spec.lastIndexOf("@")
  if (separator > 0) return { name: spec.slice(0, separator), version: spec.slice(separator + 1) }
  return { name: spec }
}
