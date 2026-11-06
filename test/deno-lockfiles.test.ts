import { expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { parseLockfile, selectLockfile } from "../src/lockfiles.js"

const root = "/workspace"
const identity = "@demo/under_score@1.2.3_peer@2.0.0"
function lock(version: number) {
  const npm = { [identity]: { integrity: "sha512-exact", dependencies: {} }, "helper@2.0.0": { integrity: "sha512-helper" } }
  if (version === 2) return { version: "2", npm: { specifiers: { "@demo/under_score@^1": identity }, packages: npm } }
  if (version === 3) return { version: "3", packages: { specifiers: { "npm:@demo/under_score@^1": `npm:${identity}` }, npm } }
  return { version: String(version), specifiers: { "npm:@demo/under_score@^1": "1.2.3_peer@2.0.0" }, npm }
}

it.each([2, 3, 4, 5])("reads Deno %s exact npm artifacts, aliases, peer contexts and import subpaths", version => {
  const parsed = parseLockfile(`${root}/deno.lock`, JSON.stringify(lock(version)))
  expect(parsed.issues).toEqual([])
  expect(parsed.packages).toHaveLength(2)
  for (const spec of ["npm:@demo/under_score@^1", "npm:@demo/under_score@^1/submodule"]) {
    expect(parsed.direct(`${root}/packages/app`, "renamed", spec)).toMatchObject({ name: "@demo/under_score", version: "1.2.3", integrity: "sha512-exact" })
  }
  expect(parsed.direct(root, "@demo/under_score", "^1")?.version).toBe("1.2.3")
  expect(parsed.direct(root, "renamed", "npm:@demo/under_score@^9")).toBeUndefined()
})

it.each([2, 3, 4, 5])("normalizes Deno %s versionless npm selectors without choosing a range", version => {
  const npm = { "effect@3.22.1": { integrity: "sha512-exact" } }
  const contents = version === 2 ? { version: "2", npm: { specifiers: { effect: "effect@3.22.1" }, packages: npm } } :
    version === 3 ? { version: "3", packages: { specifiers: { "npm:effect": "npm:effect@3.22.1" }, npm } } :
      { version: String(version), specifiers: { "npm:effect@*": "3.22.1" }, npm }
  const parsed = parseLockfile(`${root}/deno.lock`, JSON.stringify(contents))
  expect(parsed.direct(root, "alias", "npm:effect")?.version).toBe("3.22.1")
  expect(parsed.direct(root, "effect", "*")?.version).toBe("3.22.1")
  expect(parsed.direct(root, "effect", "latest")).toBeUndefined()
})

it("rejects missing npm artifact evidence, mismatched specifier identities and nonregistry sources", () => {
  const parsed = parseLockfile(`${root}/deno.lock`, JSON.stringify({ version: "5", specifiers: {
    "npm:effect@^3": "3.22.1", "npm:missing@*": "1.0.0", "npm:patched@*": "1.0.0",
    "jsr:@std/assert@1": "1.0.0",
  }, npm: {
    "effect@3.22.1": { integrity: "sha512-effect" }, "patched@1.0.0": {},
    "git@1.0.0": { integrity: "sha512-not-registry", tarball: "https://example.com/custom.tgz" },
  }, jsr: { "@std/assert@1.0.0": { integrity: "not-npm-integrity" } }, remote: { "https://example.com/module.ts": "hash" } }))
  expect(parsed.packages.map(item => item.name)).toEqual(["effect"])
  expect(parsed.direct(root, "missing", "*")).toBeUndefined()
  expect(parsed.direct(root, "patched", "*")).toBeUndefined()
  expect(parsed.direct(root, "assert", "jsr:@std/assert@1")).toBeUndefined()
  expect(parsed.direct(root, "remote", "https://example.com/module.ts")).toBeUndefined()
  expect(parsed.issues.join(" ")).toContain("JSR")
  expect(parsed.issues.join(" ")).toContain("remote")
  const mismatch = parseLockfile(`${root}/deno.lock`, JSON.stringify({ version: "3", packages: {
    specifiers: { "npm:expected@1": "npm:other@1.0.0" }, npm: { "other@1.0.0": { integrity: "sha512-other" } },
  } }))
  expect(mismatch.direct(root, "expected", "1")).toBeUndefined()
})

it("reports unknown Deno formats and chooses Deno only with unambiguous ownership", () => {
  expect(() => parseLockfile(`${root}/deno.lock`, JSON.stringify({ version: "99" }))).toThrow("Unsupported Deno lockfile version")
  expect(selectLockfile(["deno.lock"])).toBe("deno.lock")
  expect(selectLockfile(["deno.lock", "package-lock.json"], "deno@2.5.0")).toBe("deno.lock")
  expect(() => selectLockfile(["deno.lock", "package-lock.json"])).toThrow("Ambiguous lockfiles")
})

it("rejects contradictory npm selectors after versionless normalization", () => {
  const parsed = parseLockfile(`${root}/deno.lock`, JSON.stringify({ version: "5", specifiers: {
    "npm:effect": "3.22.1", "npm:effect@*": "4.0.0",
  }, npm: { "effect@3.22.1": { integrity: "sha512-first" }, "effect@4.0.0": { integrity: "sha512-second" } } }))
  expect(parsed.direct(root, "effect", "*")).toBeUndefined()
  expect(parsed.issues.join(" ")).toContain("Conflicting Deno npm specifier")
})

it.each([2, 3])("reads the upstream Deno %s fixture with its original identities and integrity", version => {
  // Sources and upstream revision are recorded in deno-provenance.json beside the fixtures.
  const text = readFileSync(new URL(`./fixtures/lockfiles/deno-v${version}.json`, import.meta.url), "utf8")
  const original = JSON.parse(text)
  const parsed = parseLockfile(`${root}/deno.lock`, text)
  const npm = version === 2 ? original.npm.packages : original.packages.npm
  expect(parsed.packages).toHaveLength(Object.keys(npm).length)
  for (const entry of parsed.packages) expect(entry.integrity).toBe(npm[`${entry.name}@${entry.version}`].integrity)
  const expected = version === 2 ? { name: "nanoid", version: "3.3.4" } : { name: "jsonc-parser", version: "3.2.1" }
  expect(parsed.direct(root, "alias", `npm:${expected.name}`)).toMatchObject(expected)
  expect(parsed.packages.some(entry => entry.name.startsWith("@std/"))).toBe(false)
})
