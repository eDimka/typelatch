import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createBrainDatabase } from "../src/database.js"
import { brainPath } from "../src/paths.js"
import { workspaceSearch } from "../src/workspace/search.js"
import { workspaceSearchAsync } from "../src/workspace/runtime.js"

describe("workspace discovery", () => {
  let directory: string
  let root: string
  const previousHome = process.env.TYPELATCH_HOME
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const json = (path: string, value: unknown) => put(path, JSON.stringify(value))
  const search = (question: string, extra = {}) => workspaceSearch({ workspaceRoot: root, question, ...extra })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "typelatch-discovery-"))
    root = join(directory, "repo")
    process.env.TYPELATCH_HOME = join(directory, "data")
    mkdirSync(root)
    root = realpathSync(root)
    execFileSync("git", ["init", "-q", root])
    json(join(root, "package.json"), { name: "fixture", version: "1.0.0" })
    json(join(root, "tsconfig.json"), { include: ["src"] })
    put(join(root, "src/requests.ts"), "// Validate incoming requests before dispatch.\nfunction validateRequest(value: unknown) { return value !== null }\n")
    put(join(root, "test/requests.test.ts"), "// Request validation rejects null input.\nassert.equal(validateRequest(null), false)\n")
    put(join(root, "docs/requests.md"), "# Request validation\nIncoming requests must pass validation before dispatch.\n")
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.TYPELATCH_HOME
    else process.env.TYPELATCH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })

  it("discovers internal source, tests, docs and configuration without a package or config argument", async () => {
    const result = await search("request validation", { limit: 10 })
    expect(result.results.map(item => item.source)).toEqual(expect.arrayContaining([
      join(root, "src/requests.ts"), join(root, "test/requests.test.ts"), join(root, "docs/requests.md")
    ]))
    const exact = await search("validateRequest")
    expect(exact.results[0]?.symbol).toBe("validateRequest")
    expect(exact.results[0]?.line).toBe(2)
    expect(exact.results[0]?.position).toBe(readFileSync(join(root, "src/requests.ts"), "utf8").indexOf("validateRequest"))
    expect((await search("include")).results.some(item => item.source.endsWith("tsconfig.json"))).toBe(true)
    expect((await search("tsconfig.json")).results[0]?.source).toBe(join(root, "tsconfig.json"))
    expect(result.coverage.configs).toContain(join(root, "tsconfig.json"))
    expect(result.checks.resolved.status).toBe("not-run")
    expect(result.checks.typechecked.status).toBe("not-run")
    expect(result.checks.tested.status).toBe("not-run")
  })

  it("refreshes same-size edits with preserved timestamps and removes deleted and renamed files", async () => {
    const file = join(root, "src/fresh.ts")
    put(file, "const oldMarker = 1\n")
    const before = await search("oldMarker")
    expect(before.results.length).toBeGreaterThan(0)
    const warm = await search("oldMarker")
    expect(warm.index.updatedFiles).toBe(0)
    const original = statSync(file)
    put(file, "const newMarker = 1\n")
    utimesSync(file, original.atime, original.mtime)
    expect((await search("oldMarker")).results).toHaveLength(0)
    expect((await search("newMarker")).results[0]?.source).toBe(file)
    renameSync(file, join(root, "src/moved.ts"))
    expect((await search("newMarker")).results[0]?.source).toBe(join(root, "src/moved.ts"))
    rmSync(join(root, "src/moved.ts"))
    expect((await search("newMarker")).results).toHaveLength(0)
  })

  it("honors Git ignores, excludes generated files and does not follow source symlinks", async () => {
    put(join(root, ".gitignore"), "private/\n")
    put(join(root, "private/hidden.ts"), "const forbiddenMarker = 1")
    put(join(root, "dist/generated.ts"), "const forbiddenMarker = 1")
    put(join(directory, "outside.ts"), "const forbiddenMarker = 1")
    symlinkSync(join(directory, "outside.ts"), join(root, "escape.ts"))
    const result = await search("forbiddenMarker")
    expect(result.results).toHaveLength(0)
    expect(result.coverage.excluded.some(item => item.reason === "symlink")).toBe(true)
  })

  function install(name: string, version: string, at = root) {
    json(join(at, "node_modules", name, "package.json"), { name, version })
  }
  function brain(name: string, version: string, symbol: string, docs: string, identityName = name) {
    const path = brainPath(name, version)
    mkdirSync(dirname(path), { recursive: true })
    const db = createBrainDatabase(path, "baseline")
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run("package", identityName)
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run("version", version)
    db.prepare("INSERT INTO metadata VALUES (?, ?)").run("integrity", "sha512-fixture")
    db.prepare(`INSERT INTO symbols (qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count)
      VALUES (?,?,'function','index',?,?, 'index.d.ts',1,1,'',1,0,0,NULL,0)`).run(symbol, symbol, `function ${symbol}(): void`, docs)
    db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (1,?,?, 'public')").run(symbol, docs)
    db.close()
  }

  it("searches exact installed versions across nested projects and transitive packages", async () => {
    install("transport", "1.0.0")
    install("transport", "2.0.0", join(root, "packages/client"))
    json(join(root, "packages/client/package.json"), { name: "client", version: "1.0.0" })
    install("retry-helper", "3.0.0", join(root, "node_modules/transport"))
    brain("transport", "1.0.0", "sendOne", "Send payload using transport")
    brain("transport", "2.0.0", "sendTwo", "Send payload using transport")
    brain("transport", "9.0.0", "wrongLatest", "Send payload using transport")
    brain("retry-helper", "3.0.0", "retrySend", "Send payload after retry")
    const result = await search("send payload", { scope: "dependencies", limit: 10 })
    expect(result.results.map(item => item.symbol)).toEqual(expect.arrayContaining(["sendOne", "sendTwo", "retrySend"]))
    expect(result.results.some(item => item.symbol === "wrongLatest")).toBe(false)
    expect(new Set(result.results.filter(item => item.package === "transport").map(item => item.version))).toEqual(new Set(["1.0.0", "2.0.0"]))
  })

  it("reports missing indexes and rejects mismatched metadata without hiding other results", async () => {
    install("missing", "1.2.3")
    install("broken", "1.0.0")
    brain("broken", "1.0.0", "validateRequest", "request validation", "other-package")
    const result = await search("request validation")
    expect(result.status).toBe("partial")
    expect(result.results.some(item => item.origin === "workspace")).toBe(true)
    expect(result.results.some(item => item.package === "broken")).toBe(false)
    expect(result.coverage.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ package: "missing", version: "1.2.3", status: "missing-index" }),
      expect.objectContaining({ package: "broken", status: "error" })
    ]))
  })

  it("uses exact npm lock identities when dependencies are not installed", async () => {
    json(join(root, "package-lock.json"), { lockfileVersion: 3, packages: {
      "": { name: "fixture" }, "node_modules/transport": { version: "1.0.0", integrity: "sha512-fixture" }
    } })
    brain("transport", "1.0.0", "sendOne", "Send payload using transport")
    const result = await search("send payload", { scope: "dependencies" })
    expect(result.results[0]).toMatchObject({ package: "transport", version: "1.0.0" })
    expect(result.coverage.dependencies[0]).toMatchObject({ identity: "lockfile", installed: false })
  })

  it("keeps an empty search distinct from an incomplete one and bounds output", async () => {
    const result = await search("unfindableNeedle", { scope: "workspace", limit: 1 })
    expect(result.status).toBe("empty")
    expect(result.coverage.complete).toBe(true)
    expect((await search("request", { limit: 1 })).results).toHaveLength(1)
    await expect(search("request", { limit: 0 })).rejects.toThrow()
    await expect(search("request", { file: "../outside.ts" })).rejects.toThrow()
  })

  it("discovers a new file and removes it when Git ignore rules change", async () => {
    await search("freshDiscovery")
    put(join(root, "scratch/new.ts"), "const freshDiscovery = true")
    expect((await search("freshDiscovery")).results[0]?.symbol).toBe("freshDiscovery")
    put(join(root, ".gitignore"), "scratch/\n")
    const after = await search("freshDiscovery")
    expect(after.results).toHaveLength(0)
    expect(after.index?.removedFiles).toBe(1)
  })

  it("does not mistake old per-package rank for cross-package relevance", async () => {
    install("a-noise", "1.0.0")
    install("z-relevant", "1.0.0")
    brain("a-noise", "1.0.0", "sendNoise", "Send a notification")
    brain("z-relevant", "1.0.0", "sendPayload", "Send payload atomically and rollback on failure")
    const result = await search("send payload atomically rollback", { scope: "dependencies" })
    expect(result.results[0]?.package).toBe("z-relevant")
    expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score)
  })

  it("preserves exact symbol casing when merging dependency candidates", async () => {
    install("transport", "1.0.0")
    brain("transport", "1.0.0", "SendOne", "Send payload")
    const db = createBrainDatabase(brainPath("transport", "1.0.0"), "baseline")
    db.prepare(`INSERT INTO symbols (qualified_name,name,kind,module,signature,docs,source_path,line_start,line_end,source,is_public,is_deprecated,is_internal,category,example_count)
      VALUES ('sendOne','sendOne','function','index','function sendOne(): void','Send payload','index.d.ts',10,10,'',1,0,0,NULL,0)`).run()
    db.prepare("INSERT INTO symbol_search(rowid,title,body,tags) VALUES (2,'sendOne','Send payload','public')").run()
    db.close()
    expect((await search("sendOne", { scope: "dependencies" })).results[0]?.symbol).toBe("sendOne")
  })

  it("rechecks installed dependency identity and never uses a stale package version", async () => {
    install("transport", "1.0.0")
    brain("transport", "1.0.0", "sendOne", "Send payload")
    brain("transport", "2.0.0", "sendTwo", "Send payload")
    expect((await search("send payload", { scope: "dependencies" })).results[0]?.version).toBe("1.0.0")
    install("transport", "2.0.0")
    expect((await search("send payload", { scope: "dependencies" })).results[0]?.version).toBe("2.0.0")
  })

  it("preserves alias identity, follows an in-root virtual store and searches linked workspace source", async () => {
    const virtual = join(root, "node_modules/.pnpm/wire/node_modules")
    json(join(virtual, "@scope/wire/package.json"), { name: "@scope/wire", version: "1.0.0" })
    json(join(virtual, "retry-helper/package.json"), { name: "retry-helper", version: "2.0.0" })
    symlinkSync(join(virtual, "@scope/wire"), join(root, "node_modules/alias"))
    json(join(root, "package.json"), { dependencies: { alias: "npm:@scope/wire@1.0.0", shared: "workspace:*" } })
    json(join(root, "packages/shared/package.json"), { name: "shared", version: "1.0.0" })
    put(join(root, "packages/shared/internal.ts"), "function sendLocalPayload() {}")
    symlinkSync(join(root, "packages/shared"), join(root, "node_modules/shared"))
    brain("@scope/wire", "1.0.0", "sendWire", "Send payload")
    brain("retry-helper", "2.0.0", "sendRetry", "Send payload")
    const result = await search("send payload")
    expect(result.coverage.complete).toBe(true)
    expect(result.results.map(item => item.package)).toEqual(expect.arrayContaining(["@scope/wire", "retry-helper"]))
    expect(result.results.some(item => item.symbol === "sendLocalPayload" && item.origin === "workspace")).toBe(true)
    expect(result.coverage.dependencies.some(item => item.package === "shared" || item.package === "alias")).toBe(false)
  })

  it("retains lock integrity checks for installed dependencies", async () => {
    install("transport", "1.0.0")
    json(join(root, "package-lock.json"), { lockfileVersion: 3, packages: {
      "node_modules/transport": { version: "1.0.0", integrity: "sha512-different" }
    } })
    brain("transport", "1.0.0", "sendOne", "Send payload")
    const result = await search("send payload", { scope: "dependencies" })
    expect(result.coverage.dependencies[0]?.status).toBe("error")
    expect(result.results).toHaveLength(0)
  })

  it("reports oversized files and lockfile artifact mismatches as incomplete coverage", async () => {
    put(join(root, "large.txt"), "x".repeat(1_000_001))
    json(join(root, "package-lock.json"), { lockfileVersion: 3, packages: {
      "node_modules/transport": { version: "1.0.0", integrity: "sha512-different" }
    } })
    brain("transport", "1.0.0", "sendOne", "Send payload")
    const result = await search("send payload")
    expect(result.status).toBe("partial")
    expect(result.coverage.issues.some(issue => issue.includes("1 MB"))).toBe(true)
    expect(result.coverage.dependencies[0]?.status).toBe("error")
    expect(result.results).toHaveLength(0)
  })

  it("searches non Git directories with an explicit ignore coverage limitation", async () => {
    rmSync(join(root, ".git"), { recursive: true })
    const result = await search("validateRequest", { scope: "workspace" })
    expect(result.results[0]?.symbol).toBe("validateRequest")
    expect(result.status).toBe("partial")
    expect(result.coverage.selection).toContain("Git ignore rules unavailable")
  })

  it("isolates caches by root and supports cancellation", async () => {
    const other = join(directory, "other")
    mkdirSync(other)
    execFileSync("git", ["init", "-q", other])
    await search("validateRequest")
    expect((await workspaceSearch({ workspaceRoot: other, question: "validateRequest" })).results).toHaveLength(0)
    const controller = new AbortController()
    controller.abort()
    await expect(workspaceSearch({ workspaceRoot: root, question: "request" }, { signal: controller.signal })).rejects.toThrow()
  })

  it("returns search results through the bounded worker and enforces its deadline", async () => {
    const result = await workspaceSearchAsync({ workspaceRoot: root, question: "validateRequest", scope: "workspace" })
    expect(result.results[0]?.symbol).toBe("validateRequest")
    await expect(workspaceSearchAsync({ workspaceRoot: root, question: "request", timeoutMs: 1 })).rejects.toThrow(/timed out/)
  })
})
