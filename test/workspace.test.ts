import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { workspaceContext } from "../src/workspace/context.js"
import { validateWorkspace } from "../src/workspace/validate.js"
import { runCommand } from "../src/workspace/command.js"
import { workspaceContextAsync } from "../src/workspace/runtime.js"
import { WorkspaceProject } from "../src/workspace/project.js"

const roots: string[] = []
function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "typelatch-workspace-"))
  roots.push(root)
  write(root, "package.json", JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }))
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", strict: true, types: [], skipLibCheck: true }, include: ["src/**/*.ts"] }))
  mkdirSync(join(root, "node_modules"))
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  packageAt(root, "node_modules/widget", "2.0.0")
  write(root, "src/main.ts", 'import { convert } from "widget";\nexport const answer = convert(42);\n')
  return { root, config: join(root, "tsconfig.json"), file: "src/main.ts", importSpecifier: "widget" }
}
function packageAt(root: string, path: string, version: string) {
  write(root, `${path}/package.json`, JSON.stringify({ name: "widget", version, type: "module", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }))
  write(root, `${path}/index.d.ts`, 'export declare function convert(value: number): string;\nexport declare function convert(value: string): number;\n')
  write(root, `${path}/index.js`, 'export const convert = value => typeof value === "number" ? String(value) : Number(value);')
  write(root, `${path}/secret.d.ts`, 'export declare const secret: string;')
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("live TypeScript workspace", () => {
  it("resolves real declarations and overloads without claiming validation", () => {
    const f = fixture()
    const source = readFileSync(join(f.root, f.file), "utf8")
    const result = workspaceContext({ ...f, position: source.lastIndexOf("convert") })
    expect(result.dependency?.version).toBe("2.0.0")
    expect(result.hover?.text).toContain("convert")
    expect(result.definitions[0]?.file).toContain("widget/index.d.ts")
    expect(result.references.length).toBeGreaterThan(0)
    expect(result.checks.typechecked.status).toBe("not-run")
    expect(result.checks.artifactMatch.status).toBe("unknown")
    expect(result.snapshot.compiler.version).toBe("6.0.3")
  })

  it("uses the nearest duplicate installation and refuses a wrong-version brain", () => {
    const f = fixture()
    packageAt(f.root, "src/nested/node_modules/widget", "1.0.0")
    write(f.root, "src/nested/main.ts", 'import { convert } from "widget"; convert(1);')
    const result = workspaceContext({ ...f, file: "src/nested/main.ts", expectedVersion: "2.0.0", question: "convert a number" })
    expect(result.dependency?.version).toBe("1.0.0")
    expect(result.checks.versionMatch.status).toBe("fail")
    expect(result.brain).toBeNull()
  })

  it("honors exports restrictions instead of finding a private file on disk", () => {
    const f = fixture()
    write(f.root, f.file, 'import { secret } from "widget/secret"; export { secret };')
    const result = workspaceContext({ ...f, importSpecifier: "widget/secret" })
    expect(result.declaration).toBeNull()
    expect(result.checks.resolved.status).toBe("unknown")
  })

  it("resolves import and require conditions using the containing file mode", () => {
    const f = fixture()
    write(f.root, "node_modules/widget/package.json", JSON.stringify({ name: "widget", version: "2.0.0", type: "module", exports: { ".": { import: "./esm.d.mts", require: "./cjs.d.cts" } } }))
    write(f.root, "node_modules/widget/esm.d.mts", "export declare const mode: 'esm';")
    write(f.root, "node_modules/widget/cjs.d.cts", "export declare const mode: 'cjs';")
    write(f.root, f.file, 'import { mode } from "widget"; export { mode };')
    expect(workspaceContext(f).declaration).toContain("esm.d.mts")
    write(f.root, "src/package.json", '{"type":"commonjs"}')
    expect(workspaceContext(f).declaration).toContain("cjs.d.cts")
  })

  it("honors tsconfig paths and keeps unsaved content off disk", () => {
    const f = fixture()
    const config = JSON.parse(readFileSync(f.config, "utf8"))
    config.compilerOptions.paths = { "@local": ["./src/local.ts"] }
    writeFileSync(f.config, JSON.stringify(config))
    write(f.root, "src/local.ts", "export const local = 10;")
    const result = workspaceContext({ ...f, importSpecifier: "@local", overlays: [{ file: f.file, text: 'import { local } from "@local"; export { local };' }] })
    expect(result.declaration).toBe(join(f.root, "src/local.ts"))
    expect(result.snapshot.overlayFiles).toEqual([join(f.root, f.file)])
    expect(readFileSync(join(f.root, f.file), "utf8")).toContain('from "widget"')
  })

  it("returns unknown for an absent import and rejects excluded files", () => {
    const f = fixture()
    expect(workspaceContext({ ...f, importSpecifier: "absent" }).checks.resolved.status).toBe("unknown")
    write(f.root, "excluded.ts", "export const x = 1;")
    expect(() => workspaceContext({ ...f, file: "excluded.ts" })).toThrow("not included")
  })

  it("fails closed when checking is disabled", () => {
    const f = fixture()
    const config = JSON.parse(readFileSync(f.config, "utf8"))
    config.compilerOptions.noCheck = true
    writeFileSync(f.config, JSON.stringify(config))
    expect(() => new WorkspaceProject(f.config)).toThrow("noCheck")
  })
})

describe("executed validation evidence", () => {
  it("returns a failing CLI exit status when requested tests cannot run against overlays", async () => {
    const f = fixture()
    write(f.root, "request.json", JSON.stringify({ config: f.config, record: false, overlays: [{ file: f.file, text: "export const x = 1;" }], testCommand: [process.execPath, "-e", "process.exit(0)"] }))
    const execution = await runCommand([process.execPath, "--import", "tsx", resolve("src/cli.ts"), "validate", join(f.root, "request.json")], process.cwd())
    expect(execution.exitCode).toBe(2)
    expect(JSON.parse(execution.stdout).checks.tested.status).toBe("not-run")
  })

  it("retains execution evidence when the command damages project configuration", async () => {
    const f = fixture()
    const result = await validateWorkspace({ config: f.config, record: false, testCommand: [process.execPath, "-e", 'require("node:fs").writeFileSync("tsconfig.json", "{")'] })
    expect(result.execution?.exitCode).toBe(0)
    expect(result.checks.stable.status).toBe("fail")
    expect(result.afterSnapshotId).toBeNull()
    expect(result.success).toBe(false)
  })

  it("catches invalid overload usage despite successful symbol resolution", async () => {
    const f = fixture()
    write(f.root, f.file, 'import { convert } from "widget"; convert(true);')
    const result = await validateWorkspace({ config: f.config, record: false, testCommand: [process.execPath, "-e", "process.exit(0)"] })
    expect(result.checks.typechecked.status).toBe("fail")
    expect(result.checks.typechecked.diagnostics.some(d => d.code === 2769)).toBe(true)
    expect(result.checks.tested.status).toBe("not-run")
    expect(result.success).toBe(false)
  })

  it("requires tests for outcome success and records their actual failure", async () => {
    const f = fixture()
    const compileOnly = await validateWorkspace({ config: f.config, record: false })
    expect(compileOnly.checks.typechecked.status).toBe("pass")
    expect(compileOnly.success).toBe(false)
    const failed = await validateWorkspace({ config: f.config, record: false, testCommand: [process.execPath, "-e", "throw new Error('behavior failed')"] })
    expect(failed.checks.tested.status).toBe("fail")
    expect(failed.execution?.stderr).toContain("behavior failed")
  }, 15_000)

  it("passes a real runtime assertion and links evidence to a query", async () => {
    const f = fixture()
    const result = await validateWorkspace({ config: f.config, record: false, queryId: "test-query", testCommand: [process.execPath, "--input-type=module", "-e", 'import {convert} from "widget"; import assert from "node:assert/strict"; assert.equal(convert(42), "42");'] })
    expect(result.success).toBe(true)
    expect(result.origin).toBe("tool-executed")
    expect(result.queryId).toBe("test-query")
    expect(result.evidencePath).toBeNull()
  })

  it("refuses to run disk tests against an unsaved overlay", async () => {
    const f = fixture()
    const result = await validateWorkspace({ config: f.config, record: false, overlays: [{ file: f.file, text: "export const changed = 1;" }], testCommand: [process.execPath, "-e", "process.exit(0)"] })
    expect(result.checks.tested.status).toBe("not-run")
    expect(result.execution).toBeNull()
  })

  it("invalidates a passing command that changed compiler inputs", async () => {
    const f = fixture()
    const result = await validateWorkspace({ config: f.config, record: false, testCommand: [process.execPath, "-e", 'require("node:fs").writeFileSync("src/main.ts", "export const altered = 1;")'] })
    expect(result.checks.tested.status).toBe("pass")
    expect(result.checks.stable.status).toBe("fail")
    expect(result.success).toBe(false)
  })
})

it("bounds commands and counts timeout, spawn failure, and output overflow as failures", async () => {
  const f = fixture()
  const timeout = await runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], f.root, 100)
  expect(timeout.timedOut).toBe(true)
  expect(timeout.status).toBe("fail")
  const missing = await runCommand([join(f.root, "missing-binary")], f.root, 100)
  expect(missing.exitCode).toBeNull()
  expect(missing.status).toBe("fail")
  const overflow = await runCommand([process.execPath, "-e", 'process.stdout.write("x".repeat(2_000_000))'], f.root)
  expect(overflow.outputLimitExceeded).toBe(true)
  expect(overflow.status).toBe("fail")
})


describe("production workspace controls", () => {
  it("discovers a package and resolves an export without editing the file", () => {
    const f = fixture()
    write(f.root, f.file, "export const empty = true;")
    const result = workspaceContext({ ...f, symbol: "convert" })
    expect(result.syntheticImport).toBe(true)
    expect(result.dependency?.version).toBe("2.0.0")
    expect(result.api?.signatures).toHaveLength(2)
    expect(readFileSync(join(f.root, f.file), "utf8")).toBe("export const empty = true;")
  })

  it("times out a worker without blocking the parent and allows the next request", async () => {
    const f = fixture()
    await expect(workspaceContextAsync({ ...f, timeoutMs: 1 })).rejects.toThrow(/timed out/)
    const result = await workspaceContextAsync({ ...f, timeoutMs: 10000 })
    expect(result.dependency?.version).toBe("2.0.0")
  })

  it("cancels an active worker and records a cancelled validation as non-success", async () => {
    const f = fixture()
    const controller = new AbortController()
    const request = workspaceContextAsync({ ...f }, { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    await expect(request).rejects.toThrow(/cancelled/)
    const result = await validateWorkspace({ config: f.config, record: false }, { signal: controller.signal })
    expect(result.success).toBe(false)
    expect(result.checks.typechecked.status).toBe("unknown")
    expect(result.failure).toContain("cancelled")
  })

  it("detects a changed runtime-only assertion file", async () => {
    const f = fixture()
    write(f.root, "assertions.js", "export const expected = 42;")
    const result = await validateWorkspace({ config: f.config, record: false, testCommand: [process.execPath, "-e", 'require("node:fs").writeFileSync("assertions.js", "export const expected = 0;")'] })
    expect(result.checks.typechecked.status).toBe("pass")
    expect(result.checks.tested.status).toBe("pass")
    expect(result.checks.stable.status).toBe("fail")
    expect(result.success).toBe(false)
  })

  it("checks referenced projects from clean sources without emitting to disk", async () => {
    const f = fixture()
    write(f.root, "tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./lib" }, { path: "./app" }] }))
    const common = { target: "ES2022", module: "NodeNext", strict: true, types: [], composite: true, outDir: "./out" }
    write(f.root, "lib/tsconfig.json", JSON.stringify({ compilerOptions: common, files: ["index.ts"] }))
    write(f.root, "lib/index.ts", "export const value: number = 42;")
    write(f.root, "app/tsconfig.json", JSON.stringify({ compilerOptions: common, files: ["index.ts"], references: [{ path: "../lib" }] }))
    write(f.root, "app/index.ts", 'import { value } from "../lib/index.js"; export const answer: number = value;')
    const good = await validateWorkspace({ config: f.config, record: false })
    expect(good.checks.typechecked, JSON.stringify(good)).toMatchObject({ status: "pass" })
    const live = workspaceContext({ config: f.config, file: "app/index.ts", position: 10 })
    expect(live.snapshot.config).toBe(join(f.root, "app/tsconfig.json"))
    expect(() => readFileSync(join(f.root, "lib/out/index.d.ts"))).toThrow()
    write(f.root, "lib/index.ts", 'export const value: number = "wrong";')
    const bad = await validateWorkspace({ config: f.config, record: false })
    expect(bad.checks.typechecked.status).toBe("fail")
    expect(bad.checks.typechecked.diagnostics.some(d => d.code === 2322)).toBe(true)
  }, 20000)
})
