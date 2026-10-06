import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { workspaceSearchAsync, workerRequest } from "../src/workspace/runtime.js"
import { persistentRequest, retireIdleContextWorkers } from "../src/workspace/persistent.js"
import { runCommand } from "../src/workspace/command.js"
import type { SearchRequest } from "../src/workspace/search.js"

const write = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) }
const stable = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => ["latencyMs", "searchMs", "updatedFiles", "removedFiles"].includes(key) ? undefined : item))

describe("retained search worker", () => {
  let directory: string
  let root: string
  let processLog: string
  let originalHome: string | undefined
  let originalNodeOptions: string | undefined
  let originalPath: string | undefined
  const controllers: AbortController[] = []
  const request = (question = "oldMarker"): SearchRequest => ({ workspaceRoot: root, question, scope: "workspace" })
  const starts = () => existsSync(processLog) ? readFileSync(processLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { pid: number; argv: string[] }).filter(row => row.argv.some(value => /search-worker\.[jt]s$/.test(value))) : []

  beforeEach(() => {
    retireIdleContextWorkers()
    directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-search-session-")))
    root = join(directory, "repo")
    mkdirSync(root)
    execFileSync("git", ["init", "-q", root])
    write(join(root, "package.json"), '{"name":"session-fixture","version":"1.0.0"}')
    write(join(root, "src/main.ts"), "export function oldMarker(value: string) { return value.trim() }\n")
    originalHome = process.env.TYPELATCH_HOME
    originalNodeOptions = process.env.NODE_OPTIONS
    originalPath = process.env.PATH
    process.env.TYPELATCH_HOME = join(directory, "data")
    processLog = join(directory, "processes.jsonl")
    const probe = join(directory, "probe.mjs")
    write(probe, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(processLog)}, JSON.stringify({pid:process.pid,argv:process.argv})+'\\n');`)
    process.env.NODE_OPTIONS = `${originalNodeOptions ?? ""} --import=${pathToFileURL(probe).href}`.trim()
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const controller of controllers.splice(0)) controller.abort()
    retireIdleContextWorkers()
    for (const [key, value] of [["TYPELATCH_HOME", originalHome], ["NODE_OPTIONS", originalNodeOptions], ["PATH", originalPath]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(directory, { recursive: true, force: true })
  })

  async function equivalent(input: SearchRequest) {
    const retained = await workspaceSearchAsync(input)
    const execution = await runCommand([process.execPath, resolve("dist/workspace/search-worker.js")], process.cwd(), 10_000, JSON.stringify({ operation: "search", request: input }))
    expect(execution.status).toBe("pass")
    const envelope = JSON.parse(execution.stdout)
    expect(envelope.ok).toBe(true)
    expect(stable(retained)).toEqual(stable(envelope.result))
    return retained
  }

  it("reuses one actual search process for sequential requests", async () => {
    const first = await workspaceSearchAsync(request())
    const second = await workspaceSearchAsync(request())
    expect(stable(second)).toEqual(stable(first))
    expect(second.index?.updatedFiles).toBe(0)
    expect(starts()).toHaveLength(1)
  })

  it("matches one-shot output across restored-mtime edits, additions, renames, deletes and Git ignore changes", async () => {
    await equivalent(request())
    const source = join(root, "src/main.ts")
    const before = statSync(source)
    writeFileSync(source, readFileSync(source, "utf8").replace("oldMarker", "newMarker"))
    utimesSync(source, before.atime, before.mtime)
    expect((await equivalent(request("oldMarker"))).results).toEqual([])
    expect((await equivalent(request("newMarker"))).results[0]?.source).toBe(source)
    renameSync(source, join(root, "src/moved.ts"))
    expect((await equivalent(request("newMarker"))).results[0]?.source).toBe(join(root, "src/moved.ts"))
    rmSync(join(root, "src/moved.ts"))
    expect((await equivalent(request("newMarker"))).results).toEqual([])
    write(join(root, "scratch/new.ts"), "export const newMarker = true\n")
    expect((await equivalent(request("newMarker"))).results[0]?.source).toBe(join(root, "scratch/new.ts"))
    write(join(root, ".gitignore"), "scratch/\n")
    expect((await equivalent(request("newMarker"))).results).toEqual([])
  }, 20_000)

  it("rechecks dependency manifests and isolates data directories when the environment changes", async () => {
    write(join(root, "node_modules/widget/package.json"), '{"name":"widget","version":"1.0.0"}')
    const input = { ...request(), scope: "all" as const }
    expect((await equivalent(input)).coverage.dependencies[0]?.version).toBe("1.0.0")
    write(join(root, "node_modules/widget/package.json"), '{"name":"widget","version":"2.0.0"}')
    const updated = await equivalent(input)
    expect(updated.coverage.dependencies[0]).toMatchObject({ version: "2.0.0", status: "missing-index" })
    const priorStarts = starts().length
    process.env.TYPELATCH_HOME = join(directory, "other-data")
    const isolated = await workspaceSearchAsync(input)
    expect(isolated.index?.path).toContain("other-data")
    expect(isolated.index?.path).not.toBe(updated.index?.path)
    expect(starts()).toHaveLength(priorStarts + 1)
    expect(isolated.coverage).toEqual(updated.coverage)
  }, 15_000)

  function slowGit() {
    const marker = join(directory, "git-started.jsonl")
    const command = join(directory, "bin/git")
    write(command, `#!${process.execPath}\nimport('node:fs').then(fs=>{fs.appendFileSync(${JSON.stringify(marker)}, process.pid+'\\n'); setInterval(()=>{},1000)});\n`)
    execFileSync("chmod", ["+x", command])
    process.env.PATH = `${dirname(command)}:${originalPath ?? ""}`
    return marker
  }

  async function waitFor(file: string, count = 1) {
    for (let tries = 0; tries < 200; tries++) {
      if (existsSync(file) && readFileSync(file, "utf8").trim().split("\n").length >= count) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error("Expected instrumented child to start")
  }

  it("cancels the active process group, enforces a deadline and recovers", async () => {
    const marker = slowGit()
    const controller = new AbortController()
    controllers.push(controller)
    const pending = workspaceSearchAsync(request(), { signal: controller.signal }).catch(error => error as Error)
    await waitFor(marker)
    const gitPid = Number(readFileSync(marker, "utf8").trim().split("\n")[0])
    controller.abort()
    expect(await pending).toMatchObject({ message: "Request cancelled" })
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(gitPid, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(() => process.kill(gitPid, 0)).toThrow()
    await expect(workspaceSearchAsync({ ...request(), timeoutMs: 500 })).rejects.toThrow(/timed out/)
    process.env.PATH = originalPath
    expect((await equivalent(request())).results[0]?.symbol).toBe("oldMarker")
  }, 15_000)

  it("shares the two active and sixteen queued limit across search, context and checks", async () => {
    const marker = slowGit()
    const controller = new AbortController()
    controllers.push(controller)
    const pending: Promise<unknown>[] = []
    for (let i = 0; i < 2; i++) pending.push(workspaceSearchAsync(request(), { signal: controller.signal }).catch(error => error))
    await waitFor(marker, 2)
    for (let i = 0; i < 16; i++) pending.push(workerRequest(i % 2 ? "context" : "check", {}, 10_000, { signal: controller.signal }).catch(error => error))
    await expect(workspaceSearchAsync(request(), { signal: controller.signal })).rejects.toThrow("Worker queue is full")
    expect(starts()).toHaveLength(2)
    controller.abort()
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ message: "Request cancelled" })
    process.env.PATH = originalPath
    expect((await workspaceSearchAsync(request())).results[0]?.symbol).toBe("oldMarker")
  }, 15_000)

  it("preserves the search input bound and lets a one-shot CLI exit", async () => {
    await expect(workerRequest("search", { value: "x".repeat(1_000_001) }, 5_000)).rejects.toThrow(/1 MB/)
    const code = `import { workspaceSearchAsync } from ${JSON.stringify(pathToFileURL(resolve("dist/workspace/runtime.js")).href)}; await workspaceSearchAsync(${JSON.stringify(request())}); console.log('finished')`
    const execution = await runCommand([process.execPath, "--input-type=module", "-e", code], process.cwd(), 5_000)
    expect(execution.status).toBe("pass")
    expect(execution.stdout).toContain("finished")
  }, 10_000)

  it("bounds aggregate worker output and recovers after invalid or oversized responses", async () => {
    const file = join(directory, "invalid-worker.cjs")
    write(file, 'process.stdin.once("data",()=>process.stdout.write("not-json\\n"));')
    await expect(persistentRequest([process.execPath, file], "{}", performance.now() + 5000, undefined, "search")).rejects.toThrow("Search produced an invalid response")
    write(file, 'process.stdin.once("data",()=>{process.stderr.write("x".repeat(4_100_000));process.stdout.write("x".repeat(4_100_000))});')
    await expect(persistentRequest([process.execPath, file], "{}", performance.now() + 5000, undefined, "search")).rejects.toThrow("Search response exceeded 8 MB")
    expect((await workspaceSearchAsync(request())).results[0]?.symbol).toBe("oldMarker")
  }, 15_000)

  it("retires an idle worker after thirty seconds without retaining the parent event loop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    await workspaceSearchAsync(request())
    const pid = starts()[0]!.pid
    vi.advanceTimersByTime(30_001)
    vi.useRealTimers()
    for (let tries = 0; tries < 100; tries++) {
      try { process.kill(pid, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(() => process.kill(pid, 0)).toThrow()
    await workspaceSearchAsync(request())
    expect(starts()).toHaveLength(2)
  }, 10_000)
})
