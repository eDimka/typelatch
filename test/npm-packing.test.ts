import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const runNpm = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const { promisify } = await import("node:util")
  return { ...actual, execFile: Object.assign(() => undefined, { [promisify.custom]: runNpm }) }
})

import { packPackage, parsePackedArtifact } from "../src/npm.js"

const archive = Buffer.from("observed archive bytes")
const identity = {
  name: "@demo/fixture", version: "1.2.3",
  integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  tarballUrl: "https://registry.npmjs.org/@demo/fixture/-/fixture-1.2.3.tgz",
}
const packed = {
  id: "@demo/fixture@1.2.3", name: identity.name, version: identity.version,
  filename: "demo-fixture-1.2.3.tgz", size: archive.length, unpackedSize: 200,
  files: [{ path: "index.d.ts", size: 200, mode: 420 }], entryCount: 1,
}
let directory: string
function respond(response: unknown) {
  runNpm.mockImplementation(async (command: string, args: string[]) => {
    if (command === "npm") {
      directory = args[args.indexOf("--pack-destination") + 1]!
      await writeFile(join(directory, packed.filename), archive)
      return { stdout: JSON.stringify(response), stderr: "" }
    }
    expect(command).toBe(process.execPath)
    return { stdout: "", stderr: "" }
  })
}
beforeEach(() => { runNpm.mockReset(); directory = "" })
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

it.each([[packed], { [identity.name]: packed }].map(response => ({ response })))("accepts one exact legacy or npm 12 packed artifact", async ({ response }) => {
  respond(response)
  expect(parsePackedArtifact(response, identity)).toEqual(packed)
  const result = await packPackage(identity)
  try {
    expect(result.tarballPath).toBe(join(directory, packed.filename))
    expect(result.packedBytes).toBe(archive.length)
    expect(result.unpackedBytes).toBe(200)
    expect(runNpm).toHaveBeenCalledTimes(2)
  } finally { await result.cleanup() }
  expect(existsSync(directory)).toBe(false)
})

it.each([
  [], [packed, packed], null, [[packed]], {}, packed, { other: packed }, { [identity.name]: packed, other: packed },
  { [identity.name]: null }, { [identity.name]: [packed] },
  { [identity.name]: { ...packed, name: "other" } },
  { [identity.name]: { ...packed, version: "9.0.0" } },
  { [identity.name]: { ...packed, id: "@demo/fixture@9.0.0" } },
  [{ ...packed, filename: "../demo-fixture-1.2.3.tgz" }],
  [{ ...packed, filename: "/demo-fixture-1.2.3.tgz" }],
  [{ ...packed, filename: "dir\\demo-fixture-1.2.3.tgz" }],
  [{ ...packed, filename: "other-1.2.3.tgz" }],
  [{ ...packed, size: -1 }], [{ ...packed, size: "20" }], [{ ...packed, unpackedSize: null }],
].map(response => ({ response })))("rejects ambiguous, mismatched or malformed npm pack JSON %j", async ({ response }) => {
  respond(response)
  await expect(packPackage(identity)).rejects.toThrow("npm pack returned an invalid artifact")
  expect(runNpm).toHaveBeenCalledTimes(1)
  expect(existsSync(directory)).toBe(false)
})

it("still verifies the observed archive bytes before extraction", async () => {
  respond({ [identity.name]: packed })
  await expect(packPackage({ ...identity, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` })).rejects.toThrow("Integrity mismatch")
  expect(runNpm).toHaveBeenCalledTimes(1)
  expect(existsSync(directory)).toBe(false)
})
