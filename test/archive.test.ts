import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Header, type HeaderData } from "tar"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { extractArchive } from "../src/archive.js"

describe("package archive roots", () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "typelatch-archive-")) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function archive(entries: Array<HeaderData & { text?: string }>) {
    const blocks: Buffer[] = []
    for (const { text = "", ...data } of entries) {
      const content = Buffer.from(text)
      const header = new Header({ mode: 0o644, type: "File", size: content.length, ...data })
      header.encode()
      blocks.push(header.block!, content, Buffer.alloc((512 - content.length % 512) % 512))
    }
    blocks.push(Buffer.alloc(1024))
    const path = join(root, "fixture.tar")
    writeFileSync(path, Buffer.concat(blocks))
    const destination = join(root, "extracted")
    mkdirSync(destination)
    return { path, destination }
  }

  it.each(["package", "better-sqlite3"])("normalizes the single %s archive root into package", name => {
    const { path, destination } = archive([
      { path: `${name}/`, type: "Directory" },
      { path: `${name}/package.json`, text: '{"name":"@types/better-sqlite3","version":"9.6.0"}' },
      { path: `${name}/index.d.ts`, text: "export declare const answer: number\n" }
    ])
    extractArchive(path, destination)
    expect(readdirSync(destination)).toEqual(["package"])
    expect(readFileSync(join(destination, "package/index.d.ts"), "utf8")).toBe("export declare const answer: number\n")
  })

  it("accepts an archive without an explicit top directory entry", () => {
    const { path, destination } = archive([{ path: "better-sqlite3/index.d.ts", text: "export {}" }])
    extractArchive(path, destination)
    expect(readFileSync(join(destination, "package/index.d.ts"), "utf8")).toBe("export {}")
  })

  it.each(["../outside", "/outside", "C:/outside", "package/../../outside", "package/../outside", "package\\outside", "package/line\nfeed"])("rejects unsafe path %j", unsafe => {
    const { path, destination } = archive([{ path: unsafe, text: "outside" }])
    expect(() => extractArchive(path, destination)).toThrow(/Unsafe package archive path/)
    expect(readdirSync(root).sort()).toEqual(["extracted", "fixture.tar"])
  })

  it("rejects mixed top directories instead of merging them", () => {
    const { path, destination } = archive([{ path: "package/a", text: "a" }, { path: "other/b", text: "b" }])
    expect(() => extractArchive(path, destination)).toThrow(/multiple root/)
  })

  it.each(["SymbolicLink", "Link"] as const)("rejects %s entries", type => {
    const { path, destination } = archive([{ path: "package/escape", type, linkpath: "../../outside" }])
    expect(() => extractArchive(path, destination)).toThrow(/Unsupported archive entry type/)
  })

  it("preserves the unpacked byte limit", () => {
    const { path, destination } = archive([{ path: "package/oversized", size: 512 * 1024 * 1024 + 1 }])
    expect(() => extractArchive(path, destination)).toThrow(/exceeds extraction limits/)
  })
})
