#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { formatBenchmark, runBenchmark, type BenchmarkReport } from "./benchmark.js"
import { caseFilePath, corpusCaseFile, hasCorpusCases, loadCorpus } from "./benchmark/corpus.js"
import { buildBrain } from "./indexer.js"
import { formatMetadata, formatQuery, formatStats } from "./format.js"
import { exactProjectDependency } from "./project.js"
import { planSync, type SyncPlan } from "./sync.js"
import { parseArgs } from "node:util"
import { clearScope, readScope, updateScope } from "./scope.js"
import { getSymbol, queryBrain } from "./query.js"
import { readStats, recordOutcome } from "./usage.js"

import { workspaceContextAsync, workspaceSearchAsync } from "./workspace/runtime.js"
import { validateWorkspace } from "./workspace/validate.js"
import { contextSchema, validationSchema } from "./workspace/schema.js"
import { runSupport } from "./support.js"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const [command = "help", ...args] = process.argv.slice(2)

try {
  switch (command) {
    case "setup": {
      if (args.some(arg => arg !== "--help" && arg !== "-h")) throw new Error("Usage: typelatch setup [--help]")
      const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string
      const script = fileURLToPath(new URL("../scripts/setup-mcp.sh", import.meta.url))
      const child = spawnSync("bash", [script, "--package-version", version, ...args], { stdio: "inherit" })
      if (child.error) throw new Error(`Could not start setup. Bash is required: ${child.error.message}`)
      process.exitCode = child.status ?? 1
      break
    }
    case "search": {
      const question = positional(args).join(" ")
      if (!question) throw new Error('Usage: typelatch search "<question>" [--root path] [--scope all|workspace|dependencies] [--file path] [--compact] [--json] [--limit N]')
      const response = await workspaceSearchAsync({
        workspaceRoot: resolve(stringFlag(args, "--root") ?? process.cwd()), question,
        ...(stringFlag(args, "--scope") ? { scope: stringFlag(args, "--scope") as "all" | "workspace" | "dependencies" } : {}),
        ...(stringFlag(args, "--file") ? { file: stringFlag(args, "--file")! } : {}),
        ...(flag(args, "--compact") ? { detail: "compact" as const } : {}),
        limit: numberFlag(args, "--limit") ?? 8
      })
      console.log(flag(args, "--json") ? JSON.stringify(response, null, 2) : [
        `${response.status}: ${response.results.length} results; ${response.coverage.files} workspace files; ${response.coverage.searchedDependencies}/${response.coverage.dependencyCount} dependency indexes searched`,
        ...response.results.map(item => `\n${item.origin === "dependency" ? `${item.package}@${item.version} ` : ""}${item.source}:${item.line}${item.symbol ? ` ${item.symbol}` : ""}\n${item.snippet}${"preview" in item && item.preview.omittedCharacters ? `\n[${item.preview.omittedCharacters} characters omitted]` : ""}`),
        ...(response.coverage.complete ? [] : [`\nIncomplete coverage: ${response.coverage.missingIndexes} missing indexes, ${response.coverage.dependencyErrors} index errors. ${response.coverage.issues.join("; ")} Use --json for details.`]),
        `\n${response.next}`
      ].join("\n"))
      break
    }
    case "support": {
      const report = await runSupport(positional(args)[0] ?? "examples/support/manifest.json", positional(args)[1] ?? "docs/benchmarks/support.json", message => console.error(`→ ${message}`))
      console.log(JSON.stringify({ passed: report.passed, navigationPassed: report.navigationPassed, totals: report.totals }, null, 2))
      const requiredGate = stringFlag(args, "--gate") ?? "discovery"
      if (!["discovery", "navigation"].includes(requiredGate)) throw new Error("--gate must be discovery or navigation")
      if (!(requiredGate === "navigation" ? report.navigationPassed : report.passed)) process.exitCode = 2
      break
    }
    case "workspace": {
      if (!args[0]) throw new Error("Usage: typelatch workspace <request.json>")
      console.log(JSON.stringify(await workspaceContextAsync(contextSchema.parse(JSON.parse(readFileSync(args[0], "utf8")))), null, 2))
      break
    }
    case "validate": {
      if (!args[0]) throw new Error("Usage: typelatch validate <request.json>")
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
    case "scope":
      await scopeCommand(args)
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
  console.error(`typelatch: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

async function addCommand(args: string[]): Promise<void> {
  const requested = positional(args)[0]
  if (!requested) throw new Error("Usage: typelatch add <package[@version]>")
  let spec = requested
  if (!hasExplicitVersion(requested)) {
    const exact = await exactProjectDependency(process.cwd(), requested)
    if (exact) spec = `${exact.name}@${exact.version}`
  }
  const result = await buildBrain(spec, { onProgress: (phase) => console.error(`→ ${phase}`) })
  console.log(formatMetadata(result.metadata, result.path))
}

async function scopeCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } })
  const [action = "list", ...projects] = positionals
  if (!["list", "add", "remove", "set", "clear"].includes(action)) throw new Error("Usage: typelatch scope <list|add|remove|set|clear> [project ...] [--json]")
  if (["list", "clear"].includes(action) ? projects.length > 0 : projects.length === 0) throw new Error(`${action} ${["list", "clear"].includes(action) ? "does not accept project paths" : "requires at least one project path"}`)
  if (action === "clear") {
    const result = await clearScope(process.cwd())
    const activeScope = await readScope(process.cwd())
    console.log(values.json ? JSON.stringify({ ...result, activeScope }, null, 2) : activeScope ? `Saved scope removed. Now using ${activeScope.path}.` : "Saved scope cleared. Sync defaults to the current package; search defaults to the requested workspace.")
    return
  }
  const scope = action === "list" ? await readScope(process.cwd()) : await updateScope(process.cwd(), action as "add" | "remove" | "set", projects)
  console.log(values.json ? JSON.stringify({ configured: scope !== null, ...(scope ?? {}) }, null, 2) : scope ? [
    `Saved scope: ${scope.path}`,
    ...scope.projects.map(project => `  ${project}`),
    ...(scope.projects.length ? [] : ["  Empty selection. No projects will be indexed."]),
    "Sync and workspace search use this selection. Add projects with typelatch scope add <path>."
  ].join("\n") : "No saved scope. Sync defaults to the current package; search defaults to the requested workspace.")
}

async function syncCommand(args: string[]): Promise<void> {
  const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, tokens: true, options: {
    project: { type: "string", multiple: true }, workspaces: { type: "boolean" }, lockfile: { type: "string" },
    "dry-run": { type: "boolean" }, json: { type: "boolean" }, force: { type: "boolean" }
  } })
  if (tokens.filter(token => token.kind === "option" && token.name === "lockfile").length > 1) throw new Error("--lockfile may only be supplied once")
  const plan = await planSync({ cwd: process.cwd(), packages: positionals,
    ...(values.project ? { projects: values.project } : {}), ...(values.workspaces ? { workspaces: true } : {}),
    ...(values.lockfile ? { lockfile: values.lockfile } : {}), ...(values.force ? { force: true } : {}) })
  if (values["dry-run"] || !plan.ready) {
    console.log(values.json ? JSON.stringify(plan, null, 2) : formatSyncPlan(plan))
    if (!plan.ready) process.exitCode = 1
    return
  }
  if (!values.json) console.log(formatSyncPlan(plan))
  const results: Array<{ name: string; version: string; status: "cached" | "indexed" | "error" | "not-run"; reason?: string }> = []
  let failed = false
  for (const target of plan.targets) {
    const identity = { name: target.name, version: target.version }
    if (failed) { results.push({ ...identity, status: "not-run", reason: "Earlier package failed" }); continue }
    if (target.cache === "ready" && !values.force) {
      results.push({ ...identity, status: "cached" })
      if (!values.json) console.log(`✓ ${target.name}@${target.version} already installed`)
      continue
    }
    try {
      const result = await buildBrain(`${target.name}@${target.version}`, {
        expectedIdentity: target,
        onProgress: phase => console.error(`→ ${target.name}: ${phase}`)
      })
      results.push({ ...identity, status: "indexed" })
      if (!values.json) console.log(`✓ ${result.metadata.package}@${result.metadata.version} · ${result.metadata.symbols} symbols`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      results.push({ ...identity, status: "error", reason })
      if (!values.json) console.error(`typelatch: ${target.name}@${target.version}: ${reason}`)
      failed = true
    }
  }
  if (values.json) console.log(JSON.stringify({ ...plan, results, success: !failed }, null, 2))
  if (failed) process.exitCode = 1
}

function formatSyncPlan(plan: SyncPlan): string {
  return [
    `Sync plan: ${plan.projects.length} projects, ${plan.targets.length} exact package versions`,
    ...(plan.savedScope ? [`Saved scope: ${plan.savedScope.path}`] : []),
    ...plan.projects.map(project => `  ${project.root} → ${project.lockfile ?? "no lockfile selected"}`),
    ...plan.targets.map(target => `  ${target.name}@${target.version}: ${target.cache}${plan.force ? " (rebuild requested)" : ""}${target.reason ? ` (${target.reason})` : ""}`),
    ...plan.skipped.map(item => `  Skipped ${item.name} in ${item.project}: ${item.reason}`),
    ...plan.issues.map(issue => `  Error: ${issue}`)
  ].join("\n")
}

function queryCommand(args: string[]): void {
  const values = positional(args)
  const packageSpec = values[0]
  const question = values.slice(1).join(" ")
  if (!packageSpec || !question) throw new Error('Usage: typelatch query <package[@version]> "<question>"')
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
  if (!packageSpec || !name) throw new Error("Usage: typelatch symbol <package[@version]> <symbol>")
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
  if (!queryId) throw new Error("Usage: typelatch feedback <query-id> [--accepted yes|no] [--compile pass|fail] [--tests pass|fail]")
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
  console.log(`Typelatch: local API evidence for TypeScript agents

Usage:
  typelatch setup
  typelatch add <package[@version]>
  typelatch scope <list|add|remove|set|clear> [project ...] [--json]
  typelatch sync [package ...] [--project path ... | --workspaces] [--lockfile path] [--dry-run] [--json] [--force]
  typelatch search <question> [--root path] [--scope all|workspace|dependencies] [--file path] [--compact] [--json] [--limit N]
  typelatch query <package[@version]> <question> [--json] [--limit N]
  typelatch symbol <package[@version]> <symbol> [--json]
  typelatch workspace <request.json>
  typelatch validate <request.json>
  typelatch feedback <queryId> [--accepted yes|no] [--compile pass|fail] [--tests pass|fail] [--notes text]
  typelatch stats [--json]
  typelatch benchmark [package@version] [--json]
  typelatch benchmark --all [--json]
  typelatch support [manifest.json] [report.json] [--gate discovery|navigation]

MCP server:
  typelatch-mcp

Data stays local in ~/.typelatch. See docs/USAGE.md for configuration.`)
}

function positional(args: string[]): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (!value) continue
    if (value.startsWith("--")) {
      if (!["--json", "--compact", "--force", "--all"].includes(value)) index++
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
