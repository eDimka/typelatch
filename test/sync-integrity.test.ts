import { beforeEach, expect, it, vi } from "vitest"
import { buildBrain } from "../src/indexer.js"
import { packPackage, resolvePackage } from "../src/npm.js"

vi.mock("../src/npm.js", () => ({ resolvePackage: vi.fn(), packPackage: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
it.each([
  { name: "effect", version: "3.22.1", integrity: "sha512-other" },
  { name: "effect", version: "3.22.0", integrity: "sha512-locked" },
  { name: "alias", version: "3.22.1", integrity: "sha512-locked" },
])("rejects a registry artifact differing from the planned lock identity %j", async identity => {
  vi.mocked(resolvePackage).mockResolvedValue({ ...identity, tarballUrl: "https://example.invalid/archive.tgz" })
  await expect(buildBrain("effect@3.22.1", {
    expectedIdentity: { name: "effect", version: "3.22.1", integrity: "sha512-locked" },
  })).rejects.toThrow("Registry artifact does not match the planned lockfile identity")
  expect(packPackage).not.toHaveBeenCalled()
})
