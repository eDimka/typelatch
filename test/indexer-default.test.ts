import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { buildBrain } from "../src/indexer.js"
import { getSymbol, queryBrain } from "../src/query.js"
import { packPackage, resolvePackage } from "../src/npm.js"

vi.mock("../src/npm.js", () => ({ resolvePackage: vi.fn(), packPackage: vi.fn() }))

it("builds the smaller package format by default without changing public API evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "typelatch-default-format-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }))
    writeFileSync(join(root, "index.d.ts"), `
/** Retry policy with an explicit attempt limit. */
export interface Policy { attempts: number }
/** Retry a failed operation using the supplied policy. */
export declare function retry(policy: Policy): Promise<void>;
`)
    vi.mocked(resolvePackage).mockResolvedValue({ name: "fixture", version: "1.0.0", integrity: "sha512-fixture", tarballUrl: "https://example.invalid/fixture.tgz" })
    vi.mocked(packPackage).mockImplementation(async () => ({ directory: root, packageRoot: root, tarballPath: "", packedBytes: 0, unpackedBytes: 200, cleanup: async () => {} }))
    const reference = await buildBrain("fixture@1.0.0", { output: join(root, "compact.db"), format: "compact" })
    const candidate = await buildBrain("fixture@1.0.0", { output: join(root, "default.db") })
    expect(candidate.metadata.format).toBe("trimmed")
    expect(candidate.metadata.integrity).toBe(reference.metadata.integrity)
    for (const question of ["retry failed operation", "Policy", "fixture.retry"]) {
      const options = { version: "1.0.0", recordUsage: false }
      expect(queryBrain("fixture", question, { ...options, brainFile: candidate.path }).results)
        .toEqual(queryBrain("fixture", question, { ...options, brainFile: reference.path }).results)
      expect(getSymbol("fixture", question, { ...options, brainFile: candidate.path }).results)
        .toEqual(getSymbol("fixture", question, { ...options, brainFile: reference.path }).results)
    }
    const hit = getSymbol("fixture", "fixture.retry", { version: "1.0.0", brainFile: candidate.path, recordUsage: false }).results[0]!
    expect(hit.signature).toContain("Policy")
    expect(hit.source).toBe("index.d.ts")
    expect(hit.relationships.some(edge => edge.target === "fixture.Policy")).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
