import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { workspaceContext, type ContextRequest } from "../src/workspace/context.js"
import { workspaceContextAsync } from "../src/workspace/runtime.js"
import { runCommand } from "../src/workspace/command.js"

const roots: string[] = []
function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}
function fixture(): ContextRequest & { root: string } {
  const root = mkdtempSync(join(tmpdir(), "typelatch-session-"))
  roots.push(root)
  write(root, "package.json", '{"name":"session-fixture","version":"1.0.0","type":"module"}')
  write(root, "base.json", '{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true,"types":[],"skipLibCheck":true}}')
  write(root, "tsconfig.json", '{"extends":"./base.json","include":["src/**/*.ts"]}')
  mkdirSync(join(root, "node_modules"))
  symlinkSync(resolve("node_modules/typescript"), join(root, "node_modules/typescript"), "dir")
  write(root, "node_modules/widget/package.json", '{"name":"widget","version":"1.0.0","type":"module","types":"index.d.ts"}')
  write(root, "node_modules/widget/index.d.ts", 'export declare const value: "one";')
  const text = 'import { value } from "widget"; export const answer = value;'
  write(root, "src/main.ts", text)
  return { root, config: join(root, "tsconfig.json"), file: "src/main.ts", importSpecifier: "widget", position: text.lastIndexOf("value"), symbol: "value" }
}
function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "latencyMs" || key === "queryId" ? undefined : item))
}
async function equivalent(request: ContextRequest) {
  const actual = await workspaceContextAsync(request)
  expect(stable(actual)).toEqual(stable(workspaceContext(request)))
  return actual
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("retained context worker", () => {
  it("matches a fresh compiler across repeated calls and same-size edits with restored mtime", async () => {
    const f = fixture()
    await equivalent(f)
    await equivalent(f)
    const declaration = join(f.root, "node_modules/widget/index.d.ts")
    const before = statSync(declaration)
    writeFileSync(declaration, readFileSync(declaration, "utf8").replace('"one"', '"two"'))
    utimesSync(declaration, before.atime, before.mtime)
    expect((await equivalent(f)).hover?.text).toContain('"two"')
    const source = readFileSync(join(f.root, f.file), "utf8")
    write(f.root, f.file, source + '\nexport const another = value;')
    expect((await equivalent(f)).references.length).toBeGreaterThan(2)
  }, 30_000)

  it("detects previously missing modules, new roots, exports and extended configuration", async () => {
    const f = fixture()
    const request = { ...f, importSpecifier: "missing", position: undefined, symbol: "added" }
    write(f.root, f.file, 'import { added } from "missing"; export { added };')
    expect((await equivalent(request)).declaration).toBeNull()
    write(f.root, "node_modules/missing/package.json", '{"name":"missing","version":"1.0.0","types":"index.d.ts"}')
    write(f.root, "node_modules/missing/index.d.ts", 'export declare const added: 1;')
    expect((await equivalent(request)).api?.type).toBe("1")
    write(f.root, f.file, 'import { value } from "widget"; export const answer = value;')
    await equivalent(f)
    write(f.root, "src/new.ts", 'import { value } from "widget"; export const third = value;')
    expect((await equivalent(f)).references.some(r => r.file.endsWith("new.ts"))).toBe(true)
    write(f.root, "node_modules/widget/next.d.ts", 'export declare const value: "exports";')
    write(f.root, "node_modules/widget/package.json", '{"name":"widget","version":"2.0.0","type":"module","exports":"./next.d.ts"}')
    expect((await equivalent({ ...f, expectedVersion: "1.0.0" })).checks.versionMatch.status).toBe("fail")
    write(f.root, "base.json", '{"compilerOptions":{"target":"ES2022","module":"NodeNext","strict":true,"types":[],"paths":{"widget":["./src/replacement.ts"]}}}')
    write(f.root, "src/replacement.ts", 'export const value = "local" as const;')
    expect((await equivalent(f)).hover?.text).toContain('"local"')
  }, 30_000)

  it("reselects a nearer installed config package", async () => {
    const f = fixture()
    write(f.root, "node_modules/config-base/tsconfig.json", '{"compilerOptions":{"strict":false,"module":"NodeNext","types":[]}}')
    write(f.root, "configs/project/tsconfig.json", '{"extends":"config-base","files":["../../src/main.ts"]}')
    write(f.root, "node_modules/widget/index.d.ts", 'export declare const value: number | null;')
    const request = { ...f, config: join(f.root, "configs/project/tsconfig.json"), file: "../../src/main.ts" }
    expect((await equivalent(request)).hover?.text).not.toContain("null")
    write(f.root, "configs/node_modules/config-base/tsconfig.json", '{"compilerOptions":{"strict":true,"module":"NodeNext","types":[]}}')
    expect((await equivalent(request)).hover?.text).toContain("null")
  }, 30_000)

  it("reloads compiler entry points and implementation changes across overlay switches", async () => {
    const f = fixture()
    const compiler = join(f.root, "node_modules/typescript")
    rmSync(compiler)
    const actualCompiler = resolve("node_modules/typescript/lib/typescript.js")
    const wrapper = (version: string) => `module.exports = { ...require(${JSON.stringify(actualCompiler)}), version: ${JSON.stringify(version)} };`
    write(f.root, "node_modules/typescript/package.json", '{"main":"first.cjs"}')
    write(f.root, "node_modules/typescript/first.cjs", wrapper("first"))
    write(f.root, "node_modules/typescript/second.cjs", wrapper("second"))
    expect((await workspaceContextAsync(f)).snapshot.compiler.version).toBe("first")
    write(f.root, "node_modules/typescript/package.json", '{"main":"second.cjs"}')
    expect((await workspaceContextAsync(f)).snapshot.compiler.version).toBe("second")
    write(f.root, "node_modules/typescript/second.cjs", wrapper("third"))
    const overlays = [{ file: f.file, text: readFileSync(join(f.root, f.file), "utf8") }]
    expect((await workspaceContextAsync({ ...f, overlays })).snapshot.compiler.version).toBe("third")
    // Exercise the no-retained-project path as well (temporary import probe).
    await workspaceContextAsync({ ...f, importSpecifier: "missing" })
    write(f.root, "node_modules/typescript/second.cjs", wrapper("fourth"))
    expect((await workspaceContextAsync({ ...f, importSpecifier: "missing" })).snapshot.compiler.version).toBe("fourth")
  }, 30_000)

  it("does not leak overlays or package evidence between requests", async () => {
    const f = fixture()
    await equivalent(f)
    const text = 'import { value } from "widget"; export const answer = "unsaved" as const;'
    const overlay = { ...f, position: text.lastIndexOf("answer"), overlays: [{ file: f.file, text }] }
    expect((await equivalent(overlay)).hover?.text).toContain("unsaved")
    await equivalent(overlay)
    await equivalent(f)
    await equivalent({ ...f, importSpecifier: undefined, symbol: undefined })
    await equivalent(f)
  }, 30_000)

  it("cancels, times out, and recovers without poisoning other requests", async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(workspaceContextAsync(f, { signal: controller.signal })).rejects.toThrow("cancelled")
    await expect(workspaceContextAsync({ ...f, timeoutMs: 1 })).rejects.toThrow(/timed out/)
    await equivalent(f)
    const active = new AbortController()
    const request = workspaceContextAsync({ ...f, overlays: [{ file: f.file, text: readFileSync(join(f.root, f.file), "utf8") }] }, { signal: active.signal })
    setTimeout(() => active.abort(), 5)
    await expect(request).rejects.toThrow("cancelled")
    const results = await Promise.all([workspaceContextAsync(f), workspaceContextAsync(f), workspaceContextAsync(f)])
    for (const result of results) expect(stable(result)).toEqual(stable(workspaceContext(f)))
  }, 30_000)

  it("allows a one-off CLI process to exit after a retained worker request", async () => {
    const f = fixture()
    const code = `import { workspaceContextAsync } from ${JSON.stringify(new URL("../dist/workspace/runtime.js", import.meta.url).href)}; await workspaceContextAsync(${JSON.stringify(f)}); console.log("finished")`
    const result = await runCommand([process.execPath, "--input-type=module", "-e", code], process.cwd(), 10_000)
    expect(result.timedOut).toBe(false)
    expect(result.status).toBe("pass")
    expect(result.stdout).toContain("finished")
  }, 15_000)
})
