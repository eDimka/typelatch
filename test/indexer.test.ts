import { describe, expect, it } from "vitest"
import { moduleIsPublic } from "../src/indexer.js"

describe("moduleIsPublic", () => {
  const exportsModules = new Set(["minimatch", "commonjs/index", "dist/commonjs/index.js"])

  it("treats declaration-mode modules as public even when the exports map never matches", () => {
    // Declaration-mode packages (e.g. minimatch) compute modules like
    // "commonjs/index" that never equal an exports key such as
    // "./dist/commonjs/index.js", so the exports-map check must be bypassed.
    expect(moduleIsPublic("commonjs/index", exportsModules, "declaration")).toBe(true)
    expect(moduleIsPublic("minimatch", exportsModules, "declaration")).toBe(true)
    expect(moduleIsPublic("some/deep/module", new Set(), "declaration")).toBe(true)
  })

  it("keeps declaration-mode modules with an internal segment private", () => {
    expect(moduleIsPublic("internal/foo", exportsModules, "declaration")).toBe(false)
    expect(moduleIsPublic("lib/internal/helpers", exportsModules, "declaration")).toBe(false)
    expect(moduleIsPublic("internalize", exportsModules, "declaration")).toBe(true)
  })

  it("keeps source-mode behavior when no exports map exists", () => {
    expect(moduleIsPublic("Effect", new Set(), "source")).toBe(true)
    expect(moduleIsPublic("internal/util", new Set(), "source")).toBe(false)
    expect(moduleIsPublic("dist/chunks/shared", new Set(), "source")).toBe(false)
  })

  it("keeps source-mode behavior against the exports map", () => {
    expect(moduleIsPublic("minimatch", exportsModules, "source")).toBe(true)
    expect(moduleIsPublic("minimatch/subpath", exportsModules, "source")).toBe(true)
    expect(moduleIsPublic("unexported/module", exportsModules, "source")).toBe(false)
  })
})
