import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"

let directory: string
let root: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-parser-loading-")))
  root = join(directory, "repo")
  mkdirSync(root)
  execFileSync("git", ["init", "-q", root])
  writeFileSync(join(root, "main.ts"), "export const freshMarker = 1\n")
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function search(detail = "full") {
  const module = pathToFileURL(join(process.cwd(), "dist/workspace/search.js")).href
  const script = `
    import { createRequire } from 'node:module';
    import { workspaceSearch } from ${JSON.stringify(module)};
    const response = await workspaceSearch(${JSON.stringify({ workspaceRoot: root, question: "freshMarker", scope: "workspace", detail })});
    const paths = Object.keys(createRequire(import.meta.url).cache);
    const parsers = ['typescript/lib/typescript.js', 'yaml/dist/index.js', '@yarnpkg/parsers/lib/index.js'].filter(name => paths.some(path => path.endsWith('/' + name)));
    console.log(JSON.stringify({ parsers, status: response.status, updatedFiles: response.index.updatedFiles, results: response.results, sourceContext: response.sourceContext }));
  `
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, TYPELATCH_HOME: join(directory, "data") }
  }))
}

it("loads no language or lockfile parser when a new process reuses unchanged search content", () => {
  const cold = search()
  const warm = search()
  expect(cold.status).toBe("ok")
  expect(cold.parsers).toContain("typescript/lib/typescript.js")
  expect(warm.updatedFiles).toBe(0)
  expect(warm.results).toEqual(cold.results)
  expect(warm.parsers).toEqual([])
})

it("loads the language parser again when content changes or source expansion requires it", () => {
  search()
  writeFileSync(join(root, "main.ts"), "export const freshMarker = 2\n")
  const changed = search()
  expect(changed.updatedFiles).toBe(1)
  expect(changed.parsers).toEqual(["typescript/lib/typescript.js"])
  expect(changed.results[0].snippet).toContain("= 2")
  const source = search("source")
  expect(source.updatedFiles).toBe(0)
  expect(source.parsers).toEqual(["typescript/lib/typescript.js"])
  expect(source.sourceContext.files[0].text).toContain("= 2")
})
