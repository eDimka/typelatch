import { beforeEach, expect, it, vi } from "vitest"

const runNpm = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  const { promisify } = await import("node:util")
  return { ...actual, execFile: Object.assign(() => undefined, { [promisify.custom]: runNpm }) }
})

import { resolvePackage } from "../src/npm.js"

const artifact = {
  name: "is-number", version: "6.0.0",
  "dist.integrity": "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
  "dist.tarball": "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
}
const respond = (value: unknown) => runNpm.mockResolvedValue({ stdout: JSON.stringify(value), stderr: "" })
beforeEach(() => runNpm.mockReset())

it.each([artifact, [artifact]].map(response => ({ response })))("accepts one exact npm artifact from legacy object or npm 12 array output", async ({ response }) => {
  respond(response)
  expect(await resolvePackage("is-number@6.0.0")).toEqual({
    name: artifact.name, version: artifact.version, integrity: artifact["dist.integrity"], tarballUrl: artifact["dist.tarball"],
  })
  expect(runNpm).toHaveBeenCalledWith("npm", ["view", "is-number@6.0.0", "name", "version", "dist.integrity", "dist.tarball", "--json"], expect.any(Object))
})

it.each([
  [], [artifact, artifact], null, [null], [[]], ["is-number"], [{ ...artifact, version: undefined }],
  [{ ...artifact, "dist.integrity": undefined }], [{ ...artifact, "dist.tarball": undefined }],
].map(response => ({ response })))("rejects ambiguous or malformed npm view JSON %j", async ({ response }) => {
  respond(response)
  await expect(resolvePackage("is-number@6.0.0")).rejects.toThrow("Registry did not resolve one exact artifact")
})

it.each([
  [{ ...artifact, name: "../outside" }],
  [{ ...artifact, version: "^6.0.0" }],
].map(response => ({ response })))("still validates the identity inside a singleton response %j", async ({ response }) => {
  respond(response)
  await expect(resolvePackage("is-number@6.0.0")).rejects.toThrow()
})
