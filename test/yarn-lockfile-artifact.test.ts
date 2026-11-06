import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it } from "vitest"
import { parseLockfile } from "../src/lockfiles.js"
import { projectDependencies } from "../src/project.js"
import { planSync } from "../src/sync.js"

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "typelatch-yarn-artifact-")))
  execFileSync("git", ["init", "-q", root])
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const classic = (selector: string, version: string, resolved: string) => `# yarn lockfile v1\n\n${selector}:\n  version "${version}"\n  resolved "${resolved}"\n`

it("does not turn a grouped Yarn tarball override into a registry package without integrity", async () => {
  // Yarn 1.22.22 generated this shape from an HTTP resolution override.
  const text = classic('is-number@^6.0.0, "is-number@http://127.0.0.1:54321/custom.tgz"', "6.0.0", "http://127.0.0.1:54321/custom.tgz#0da7d67dd33fa435c91142bf0a08f91c79d8d3d1")
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "is-number": "^6.0.0" }, resolutions: { "is-number": "http://127.0.0.1:54321/custom.tgz" } }))
  writeFileSync(join(root, "yarn.lock"), text)
  const lock = parseLockfile(join(root, "yarn.lock"), text)
  expect(lock.packages).toEqual([])
  expect(lock.direct(root, "is-number", "^6.0.0")).toBeUndefined()
  await expect(projectDependencies(root)).rejects.toThrow("No exact locked registry identity")
  const plan = await planSync({ cwd: root })
  expect(plan.ready).toBe(false)
  expect(plan.targets).toEqual([])
})

it.each([
  ["plain", "1.2.3", "https://registry.npmjs.org/plain/-/plain-1.2.3.tgz#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["plain", "1.2.3", "https://registry.yarnpkg.com/plain/-/plain-1.2.3.tgz#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ["@demo/pkg", "1.2.3", "https://registry.npmjs.org/@demo/pkg/-/pkg-1.2.3.tgz#aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
])("preserves an ordinary canonical %s artifact without inventing an integrity value", (name, version, resolved) => {
  const lock = parseLockfile(join(root, "yarn.lock"), classic(`"${name}@^${version}"`, version, resolved))
  expect(lock.issues).toEqual([])
  expect(lock.direct(root, name, `^${version}`)).toMatchObject({ name, version })
  expect(lock.direct(root, name, `^${version}`)?.integrity).toBeUndefined()
})

it.each([
  "https://registry.npmjs.org/other/-/other-1.2.3.tgz",
  "https://registry.npmjs.org/plain/-/plain-9.9.9.tgz",
  "https://registry.npmjs.org/plain/-/modified.tgz",
  "https://registry.npmjs.org.evil.invalid/plain/-/plain-1.2.3.tgz",
  "https://private.example.invalid/plain/-/plain-1.2.3.tgz",
  "https://user:fixture-password@registry.npmjs.org/plain/-/plain-1.2.3.tgz",
])("rejects an explicit mismatched or custom Classic artifact source %s", resolved => {
  const lock = parseLockfile(join(root, "yarn.lock"), classic("plain@^1.2.3", "1.2.3", resolved))
  expect(lock.packages).toEqual([])
  expect(lock.direct(root, "plain", "^1.2.3")).toBeUndefined()
  expect(lock.issues).not.toEqual([])
  expect(JSON.stringify(lock.issues)).not.toContain("fixture-password")
})
