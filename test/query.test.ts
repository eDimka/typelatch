import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { exactProjectVersion, projectDependencies } from "../src/project.js"
import { getSymbol, queryBrain } from "../src/query.js"
import { readStats, recordOutcome } from "../src/usage.js"

describe("local brain", () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), "apirova-test-"))
  const compactPath = join(temporaryHome, "compact.db")
  const previousHome = process.env.APIROVA_HOME

  beforeAll(() => {
    process.env.APIROVA_HOME = temporaryHome
    seedBrain()
    seedCompactBrain()
  })

  afterAll(() => {
    if (previousHome === undefined) delete process.env.APIROVA_HOME
    else process.env.APIROVA_HOME = previousHome
    rmSync(temporaryHome, { recursive: true, force: true })
  })

  it("ranks the exact-cased symbol before a namespace differing only by case", () => {
    const response = getSymbol("effect", "Effect.retry", { version: "3.22.1" })
    expect(response.results[0]?.symbol).toBe("Effect.retry")
    expect(response.strategy).toBe("exact")
  })

  it("combines lexical evidence with public API preference", () => {
    const response = queryBrain("effect", "retry with exponential delay", { version: "3.22.1" })
    expect(new Set(response.results.slice(0, 2).map((result) => result.symbol))).toEqual(new Set([
      "Effect.retry",
      "Schedule.exponential"
    ]))
  })

  it("does not crash on questions containing object prototype property names", () => {
    const response = queryBrain("effect", "How does the constructor option work?", { version: "3.22.1", recordUsage: false })
    expect(Array.isArray(response.results)).toBe(true)
  })

  it("records retrieval and correlated coding outcomes locally", () => {
    const response = queryBrain("effect", "retry operation", { version: "3.22.1" })
    recordOutcome(response.queryId, { accepted: true, compilePassed: true, testsPassed: true })
    const stats = readStats()
    expect(stats.queries).toBe(3)
    expect(stats.hitRate).toBe(1)
    expect(stats.outcomes).toBe(1)
    expect(stats.testPasses).toBe(1)
  })

  it("keeps ranked results and relationships identical across storage formats", () => {
    for (const question of ["Effect.retry", "retry with exponential delay"]) {
      const baseline = queryBrain("effect", question, { version: "3.22.1", recordUsage: false })
      const compact = queryBrain("effect", question, {
        version: "3.22.1",
        brainFile: compactPath,
        recordUsage: false
      })
      expect(compact.results).toEqual(baseline.results)
    }
  })

  function seedBrain(): void {
    const path = brainPath("effect", "3.22.1")
    mkdirSync(dirname(path), { recursive: true })
    const db = createBrainDatabase(path, "baseline")
    const insert = db.prepare(`
      INSERT INTO symbols (
        qualified_name, name, kind, module, signature, docs, source_path,
        line_start, line_end, source, is_public, is_deprecated, is_internal,
        category, example_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const search = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
    const rows = [
      ["Effect.Retry", "Retry", "namespace", "Effect", "namespace Retry", "Retry option types.", "src/Effect.ts", 10, 20, "", 1, 0, 0, "Error handling", 0],
      ["Effect.retry", "retry", "const", "Effect", "retry(policy: Schedule)", "Retries an operation using a schedule, including exponential delays.", "src/Effect.ts", 30, 40, "", 1, 0, 0, "Error handling", 2],
      ["Schedule.exponential", "exponential", "const", "Schedule", "exponential(base: Duration)", "Creates exponentially increasing retry delays.", "src/Schedule.ts", 50, 60, "", 1, 0, 0, "Constructors", 1]
    ] as const
    for (const row of rows) {
      const result = insert.run(...row)
      search.run(result.lastInsertRowid, `${row[0]} ${row[1]}`, `${row[5]} ${row[4]}`, `${row[12] ? "internal" : "public"} ${row[3]}`)
    }
    db.prepare("INSERT INTO edges (from_symbol, to_symbol, type, evidence) VALUES (?, ?, ?, ?)")
      .run("Effect.retry", "Schedule.exponential", "references", "retry policy")
    db.close()
  }

  function seedCompactBrain(): void {
    const db = createBrainDatabase(compactPath, "compact")
    db.prepare("INSERT INTO metadata (key, value) VALUES ('schemaVersion', '2'), ('format', 'compact')").run()
    const insertNode = db.prepare("INSERT INTO nodes (qualified_name) VALUES (?)")
    const insert = db.prepare(`
      INSERT INTO symbols (
        id, qualified_name, name, kind, module, signature, docs, source_path,
        line_start, line_end, source, is_public, is_deprecated, is_internal,
        category, example_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const search = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
    const rows = [
      ["Effect.Retry", "Retry", "namespace", "Effect", "namespace Retry", "Retry option types.", "src/Effect.ts", 10, 20, 1, 0, 0, "Error handling", 0],
      ["Effect.retry", "retry", "const", "Effect", "retry(policy: Schedule)", "Retries an operation using a schedule, including exponential delays.", "src/Effect.ts", 30, 40, 1, 0, 0, "Error handling", 2],
      ["Schedule.exponential", "exponential", "const", "Schedule", "exponential(base: Duration)", "Creates exponentially increasing retry delays.", "src/Schedule.ts", 50, 60, 1, 0, 0, "Constructors", 1]
    ] as const
    const ids = new Map<string, number>()
    for (const row of rows) ids.set(row[0], Number(insertNode.run(row[0]).lastInsertRowid))
    for (const row of rows) {
      const id = ids.get(row[0])
      if (id === undefined) throw new Error(`missing test node ${row[0]}`)
      insert.run(id, row[0], ...row.slice(1, 9), "", ...row.slice(9))
      search.run(id, `${row[0]} ${row[1]}`, `${row[5]} ${row[4]}`, `${row[11] ? "internal" : "public"} ${row[3]}`)
    }
    db.prepare("INSERT INTO edges (from_id, type, to_id, evidence) VALUES (?, ?, ?, ?)")
      .run(ids.get("Effect.retry"), 3, ids.get("Schedule.exponential"), "retry policy")
    db.close()
  }
})

describe("npm lockfile detection", () => {
  it("uses the exact installed version instead of the package.json range", async () => {
    const directory = mkdtempSync(join(tmpdir(), "apirova-project-"))
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ dependencies: { effect: "^3.20.0" } }))
      writeFileSync(join(directory, "package-lock.json"), JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/effect": { version: "3.22.1" } }
      }))
      await expect(exactProjectVersion(directory, "effect")).resolves.toBe("3.22.1")
      await expect(projectDependencies(directory)).resolves.toEqual([{ name: "effect", version: "3.22.1" }])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
