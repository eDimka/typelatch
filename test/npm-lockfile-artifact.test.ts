import { expect, it } from "vitest"
import { parseLockfile } from "../src/lockfiles.js"

const root = "/workspace"
const contents = (lockfileVersion: number, value: Record<string, unknown>) => JSON.stringify({
  lockfileVersion,
  ...(lockfileVersion === 1 ? { dependencies: { "is-number": value } } : { packages: { "node_modules/is-number": value } }),
})

it.each([1, 2, 3, 4])("rejects npm schema %s custom registry artifacts without integrity", version => {
  // npm 10 package-lock-only emits this shape when registry metadata has no digest.
  const lock = parseLockfile(`${root}/package-lock.json`, contents(version, {
    version: "6.0.0", resolved: "http://127.0.0.1:54582/custom.tgz",
  }))
  expect(lock.packages).toEqual([])
  expect(lock.direct(root, "is-number", "6.0.0")).toBeUndefined()
  expect(lock.issues).not.toEqual([])
})

it.each([1, 2, 3, 4])("retains canonical npm schema %s artifacts without inventing integrity", version => {
  const lock = parseLockfile(`${root}/package-lock.json`, contents(version, {
    version: "6.0.0", resolved: "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
  }))
  expect(lock.issues).toEqual([])
  expect(lock.direct(root, "is-number", "6.0.0")).toMatchObject({ name: "is-number", version: "6.0.0" })
  expect(lock.direct(root, "is-number", "6.0.0")?.integrity).toBeUndefined()
})

it.each([1, 2, 3, 4])("rejects npm schema %s canonical URLs for a different package or version", version => {
  for (const resolved of [
    "https://registry.npmjs.org/other/-/other-6.0.0.tgz",
    "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
    "https://user:fixture-password@registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
  ]) {
    const lock = parseLockfile(`${root}/package-lock.json`, contents(version, { version: "6.0.0", resolved }))
    expect(lock.packages).toEqual([])
    expect(lock.issues).not.toEqual([])
    expect(JSON.stringify(lock.issues)).not.toContain("fixture-password")
  }
})
