import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { satisfies, validRange } from "semver"
import { assertExactVersion, assertPackageName } from "./identity.js"

const require = createRequire(import.meta.url)

export const lockfileNames = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "deno.lock"] as const
export type LockedPackage = { name: string; version: string; integrity?: string; locations: string[] }
export type Lockfile = {
  path: string; packages: LockedPackage[]; issues: string[]; workspaceRanges?: boolean
  direct(project: string, alias: string, spec: string): LockedPackage | undefined
  isLocal(project: string, alias: string, spec: string): boolean
}
type Data = Record<string, any>
const object = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
export const declaredDependencies = (manifest: Data): Record<string, string> => ({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
function registryArtifact(resolved: unknown, name: unknown, version: unknown, integrity: unknown): boolean {
  if (resolved === undefined) return true
  if (typeof resolved !== "string" || typeof name !== "string" || typeof version !== "string") return false
  try {
    const url = new URL(resolved)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return false
    // Mirror URLs require an integrity value that the downloader must match exactly.
    if (typeof integrity === "string" && /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}(?:\s+sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2})*$/.test(integrity)) return true
    const file = name.split("/").at(-1)
    return ["registry.npmjs.org", "registry.yarnpkg.com"].includes(url.hostname) && !url.port && !url.search &&
      decodeURIComponent(url.pathname) === `/${name}/-/${file}-${version}.tgz` && (!url.hash || /^#[a-fA-F0-9]{40}$/.test(url.hash))
  } catch { return false }
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function selectLockfile(names: string[], packageManager?: string): string | undefined {
  let candidates = names.filter(name => (lockfileNames as readonly string[]).includes(name))
  const modernNpm = Number(packageManager?.match(/^npm@(\d+)(?:\.|$)/)?.[1]) >= 12
  if (modernNpm) candidates = candidates.filter(name => name !== "npm-shrinkwrap.json")
  if (candidates.includes("npm-shrinkwrap.json")) candidates = candidates.filter(name => name !== "package-lock.json")
  if (candidates.includes("bun.lock")) candidates = candidates.filter(name => name !== "bun.lockb")
  const manager = packageManager?.split("@")[0]
  const preferred = manager === "npm" ? ["npm-shrinkwrap.json", "package-lock.json"] : manager === "pnpm" ? ["pnpm-lock.yaml"] : manager === "yarn" ? ["yarn.lock"] : manager === "bun" ? ["bun.lock", "bun.lockb"] : manager === "deno" ? ["deno.lock"] : []
  if (preferred.length && names.length) {
    const match = preferred.find(name => candidates.includes(name))
    if (!match) throw new Error(`No ${manager} lockfile found for packageManager ${packageManager}`)
    return match
  }
  if (candidates.length > 1) throw new Error(`Ambiguous lockfiles: ${candidates.join(", ")}; set packageManager in package.json`)
  return candidates[0]
}

export function yarnCatalogConfig(text: string): string {
  try {
    const { parseSyml } = require("@yarnpkg/parsers") as typeof import("@yarnpkg/parsers")
    const config = object(parseSyml(text))
    const entries = (value: unknown) => Object.fromEntries(Object.entries(object(value)).filter(([, spec]) => typeof spec === "string"))
    return JSON.stringify({ catalog: entries(config.catalog), catalogs: Object.fromEntries(Object.entries(object(config.catalogs)).map(([name, value]) => [name, entries(value)])) })
  } catch { throw new Error("Invalid Yarn catalog configuration") }
}

function decodeBunLockfile(text: string): string {
  const header = "#!/usr/bin/env bun\nbun-lockfile-format-v0\n"
  const bytes = Buffer.from(text, "latin1")
  if (!text.startsWith(header) || bytes.length < header.length + 4) throw new Error("Invalid binary bun.lockb header")
  if (![2, 3].includes(bytes.readUInt32LE(header.length))) throw new Error("Unsupported binary bun.lockb format; convert it to bun.lock")
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Binary bun.lockb exceeds 16 MiB")
  // Bun's Yarn printer omits patches. Fail closed on the serializer's patch tag.
  if (bytes.includes(Buffer.from("pAtChEdD"))) throw new Error("Patched binary bun.lockb requires conversion to bun.lock")
  const directory = mkdtempSync(join(tmpdir(), "typelatch-bun-lock-"))
  try {
    writeFileSync(join(directory, "bun.lockb"), bytes, { mode: 0o600 })
    try {
      return execFileSync("bun", ["bun.lockb"], {
        cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, BUN_INSTALL: directory,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Reading bun.lockb requires Bun on PATH; install Bun or convert the file to bun.lock")
      throw new Error("Cannot decode bun.lockb with Bun; verify the lockfile or convert it to bun.lock")
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

export function parseLockfile(path: string, text: string, options: { yarnConfig?: string; bunCatalogs?: string } = {}): Lockfile {
  const root = dirname(path)
  const packages: LockedPackage[] = []
  const issues: string[] = []
  const byLocation = new Map<string, LockedPackage>()
  const byKey = new Map<string, LockedPackage>()
  const localLocations = new Set<string>()
  const localSelectors = new Set<string>()
  const add = (key: string, name: unknown, version: unknown, integrity?: unknown, location?: string) => {
    if (typeof name !== "string" || typeof version !== "string") { issues.push(`No registry identity for ${key}`); return undefined }
    try { assertPackageName(name); assertExactVersion(version) } catch { issues.push(`Unsupported registry identity: ${key}`); return undefined }
    const entry: LockedPackage = { name, version, locations: [], ...(typeof integrity === "string" ? { integrity } : {}) }
    if (location) {
      const absolute = resolve(root, location)
      if (!inside(root, absolute)) { issues.push(`Lock dependency escapes workspace: ${location}`); return undefined }
      entry.locations.push(absolute)
      byLocation.set(absolute, entry)
    }
    packages.push(entry); byKey.set(key, entry)
    return entry
  }
  const located = (project: string, alias: string) => {
    assertPackageName(alias)
    let directory = project
    while (inside(root, directory)) {
      const entry = byLocation.get(resolve(directory, "node_modules", alias))
      if (entry) return entry
      if (directory === root) break
      directory = dirname(directory)
    }
    return undefined
  }
  const result: Lockfile = { path, packages, issues, direct: located, isLocal: (project, alias, spec) => {
    if (/^(workspace:|link:|file:|portal:)/.test(spec)) return true
    if (localSelectors.has(`${alias}@${spec}`) || localSelectors.has(`${alias}@npm:${spec}`)) return true
    let directory = project
    while (inside(root, directory)) {
      const location = resolve(directory, "node_modules", alias)
      if (localLocations.has(location)) return true
      if (byLocation.has(location) || directory === root) break
      directory = dirname(directory)
    }
    return false
  } }
  const file = basename(path)
  if (file === "bun.lockb") text = decodeBunLockfile(text)
  if (file === "package-lock.json" || file === "npm-shrinkwrap.json") {
    const lock = object(JSON.parse(text))
    if (![1, 2, 3, 4].includes(lock.lockfileVersion)) throw new Error(`Unsupported npm lockfile version: ${lock.lockfileVersion}`)
    if (lock.packages) {
      for (const [location, raw] of Object.entries(object(lock.packages))) {
        const value = object(raw)
        if (!location.includes("node_modules/")) continue
        if (value.link) { localLocations.add(resolve(root, location)); continue }
        if (value.patched || value.packageExtensionsApplied || value.npmExtensionApplied) { issues.push(`Unsupported repaired npm package: ${location}`); continue }
        const name = value.name ?? location.split("node_modules/").at(-1)
        if (!registryArtifact(value.resolved, name, value.version, value.integrity)) { issues.push(`Unsupported npm resolution: ${location}`); continue }
        add(location, name, value.version, value.integrity, location)
      }
    } else {
      const walk = (dependencies: Data, parent: string) => {
        for (const [name, raw] of Object.entries(dependencies)) {
          const value = object(raw)
          const location = `${parent}node_modules/${name}`
          const alias = typeof value.version === "string" && value.version.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@(.+)$/)
          const actualName = alias ? alias[1] : name, version = alias ? alias[2] : value.version
          if (!registryArtifact(value.resolved, actualName, version, value.integrity)) { issues.push(`Unsupported npm resolution: ${location}`); continue }
          add(location, actualName, version, value.integrity, location)
          walk(object(value.dependencies), `${location}/`)
        }
      }
      walk(object(lock.dependencies), "")
    }
  } else if (file === "pnpm-lock.yaml") {
    const { parseAllDocuments } = require("yaml") as typeof import("yaml")
    const documents = parseAllDocuments(text, { uniqueKeys: true })
    for (const document of documents) if (document.errors.length) throw document.errors[0]
    const lock = object(documents.at(-1)?.toJS({ maxAliasCount: 100 }))
    if (![5, 6, 9].includes(Math.floor(Number(lock.lockfileVersion)))) throw new Error(`Unsupported pnpm lockfile version: ${lock.lockfileVersion}`)
    const identity = (key: string) => {
      const clean = key.replace(/^\//, "").split("(")[0]!
      const match = clean.match(/^(@[^/]+\/[^/@]+|[^/@]+)[@/]([^/]+)$/)
      return match ? { name: match[1]!, version: match[2]!.split("_")[0]! } : undefined
    }
    for (const [key, raw] of Object.entries(object(lock.packages))) {
      const value = object(raw)
      const id = identity(key)
      const patched = id && Object.hasOwn(object(lock.patchedDependencies), `${id.name}@${id.version}`)
      if (patched || !id || value.resolution?.type || value.resolution?.directory || value.resolution?.tarball || value.patched) { issues.push(`Unsupported pnpm package: ${key}`); continue }
      add(key, value.name ?? id.name, value.version ?? id.version, value.resolution?.integrity)
    }
    const declaredLocal = result.isLocal
    result.isLocal = (project, alias, spec) => {
      const importer = relative(root, project).split(sep).join("/") || "."
      const info = object(lock.importers ? lock.importers[importer] : importer === "." ? lock : undefined)
      const dependency = declaredDependencies(info)[alias]
      const ref = typeof dependency === "string" ? dependency : object(dependency).version
      return declaredLocal(project, alias, spec) || (typeof ref === "string" && /^(link:|workspace:|file:)/.test(ref))
    }
    result.direct = (project, alias) => {
      const importer = relative(root, project).split(sep).join("/") || "."
      const info = object(lock.importers ? lock.importers[importer] : importer === "." ? lock : undefined)
      const dependency = declaredDependencies(info)[alias]
      const ref = typeof dependency === "string" ? dependency : object(dependency).version
      if (typeof ref !== "string" || /^(link:|workspace:|file:)/.test(ref) || ref.includes("patch_hash=")) return undefined
      const id = identity(ref) ?? { name: alias, version: ref.split("(")[0]!.split("_")[0]! }
      // Match the full peer context first; never infer an artifact from a range.
      return byKey.get(ref) ?? byKey.get(`${alias}@${ref}`) ?? byKey.get(`/${alias}@${ref}`) ?? byKey.get(`/${alias}/${ref}`) ??
        packages.find(entry => entry.name === id.name && entry.version === id.version)
    }
  } else if (file === "deno.lock") {
    const lock = object(JSON.parse(text))
    const version = String(lock.version)
    if (!["2", "3", "4", "5"].includes(version)) throw new Error(`Unsupported Deno lockfile version: ${lock.version}`)
    const container = version === "2" ? object(lock.npm) : version === "3" ? object(lock.packages) : lock
    const npm = object(version === "2" ? container.packages : container.npm)
    const selector = (spec: string) => {
      const match = spec.match(/^npm:(@[^/]+\/[^@/]+|[^@/]+)(?:@([^/]+))?(?:\/.*)?$/)
      return match ? { name: match[1]!, key: `npm:${match[1]}@${match[2] ?? "*"}` } : undefined
    }
    for (const [key, raw] of Object.entries(npm)) {
      const value = object(raw)
      const match = key.match(/^(@[^/]+\/[^@]+|[^@]+)@([^_]+)(?:_|$)/)
      if (!match || typeof value.integrity !== "string" || !value.integrity || value.tarball) { issues.push(`Unsupported Deno npm artifact: ${key}`); continue }
      add(key, match[1], match[2], value.integrity)
    }
    const specifiers = new Map<string, LockedPackage>()
    const conflicting = new Set<string>()
    for (const [key, raw] of Object.entries(object(container.specifiers))) {
      const requested = selector(version === "2" ? `npm:${key}` : key)
      if (!requested || typeof raw !== "string") continue
      const target = version === "2" ? raw : version === "3" ? raw.replace(/^npm:/, "") : `${requested.name}@${raw}`
      const entry = byKey.get(target)
      if (entry?.name !== requested.name || conflicting.has(requested.key)) continue
      const prior = specifiers.get(requested.key)
      if (prior && (prior.version !== entry.version || prior.integrity !== entry.integrity)) {
        specifiers.delete(requested.key)
        conflicting.add(requested.key)
        issues.push(`Conflicting Deno npm specifier: ${requested.key}`)
      } else specifiers.set(requested.key, entry)
    }
    if (Object.keys(object(container.jsr)).length) issues.push("Deno JSR packages are not supported by npm API indexing")
    if (Object.keys(object(lock.remote)).length) issues.push("Deno remote modules are not supported by npm API indexing")
    result.isLocal = (_project, _alias, spec) => /^(workspace:|link:|file:|portal:|\.\.?\/)/.test(spec)
    result.direct = (_project, alias, spec) => {
      if (!spec.startsWith("npm:") && /[:/]/.test(spec)) return undefined
      const requested = selector(spec.startsWith("npm:") ? spec : `npm:${alias}@${spec}`)
      return requested ? specifiers.get(requested.key) : undefined
    }
  } else if (file === "bun.lock") {
    const ts = require("typescript") as typeof import("typescript")
    const parsed = ts.parseConfigFileTextToJson(path, text)
    if (parsed.error) throw new Error(`Invalid bun.lock: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`)
    const lock = object(parsed.config)
    if (![0, 1, 2].includes(lock.lockfileVersion)) throw new Error(`Unsupported Bun lockfile version: ${lock.lockfileVersion}`)
    for (const [key, raw] of Object.entries(object(lock.packages))) {
      if (!Array.isArray(raw) || typeof raw[0] !== "string") { issues.push(`Unsupported Bun package: ${key}`); continue }
      const at = raw[0].indexOf("@", 1)
      const name = raw[0].slice(0, at), version = raw[0].slice(at + 1)
      if (/^(workspace:|link:|file:)/.test(version)) {
        const parts = key.match(/@[^/]+\/[^/]+|[^/]+/g) ?? []
        localLocations.add(resolve(root, parts.map(part => `node_modules/${part}`).join("/")))
        continue
      }
      if (Object.hasOwn(object(lock.patchedDependencies), `${name}@${version}`)) { issues.push(`Unsupported patched Bun package: ${key}`); continue }
      // Bun keys describe the installation tree, including nested and scoped packages.
      const parts = key.match(/@[^/]+\/[^/]+|[^/]+/g) ?? []
      add(key, name, version, raw[3], parts.map(part => `node_modules/${part}`).join("/"))
    }
    const declaredLocal = result.isLocal
    result.isLocal = (project, alias, spec) => {
      if (/^(workspace:|link:|file:|portal:)/.test(spec)) return true
      const importer = relative(root, project).split(sep).join("/")
      const workspace = object(object(lock.workspaces)[importer])
      const key = typeof workspace.name === "string" ? `${workspace.name}/${alias}` : undefined
      if (key && byKey.has(key)) return false
      if (key) {
        const parts = key.match(/@[^/]+\/[^/]+|[^/]+/g) ?? []
        if (localLocations.has(resolve(root, parts.map(part => `node_modules/${part}`).join("/")))) return true
      }
      return declaredLocal(project, alias, spec)
    }
    result.direct = (project, alias, spec) => {
      if (/^(workspace:|link:|file:)/.test(spec)) return undefined
      const importer = relative(root, project).split(sep).join("/")
      const workspace = object(object(lock.workspaces)[importer])
      const local = typeof workspace.name === "string" ? byKey.get(`${workspace.name}/${alias}`) : undefined
      return local ?? located(project, alias)
    }
  } else if (file === "yarn.lock" || file === "bun.lockb") {
    const { parseSyml } = require("@yarnpkg/parsers") as typeof import("@yarnpkg/parsers")
    const lock = object(parseSyml(text))
    result.workspaceRanges = file === "yarn.lock" && !lock.__metadata
    for (const [key, raw] of Object.entries(lock)) {
      if (key === "__metadata") continue
      const value = object(raw)
      const selectors = key.split(/,\s*/)
      let name: string | undefined
      if (file === "bun.lockb" && typeof value.version === "string" && /^(workspace:|link:|file:)/.test(value.version)) {
        for (const selector of selectors) localSelectors.add(selector)
        continue
      }
      if (lock.__metadata) {
        if (typeof value.resolution === "string" && value.resolution.includes("@workspace:")) {
          for (const selector of selectors) localSelectors.add(selector)
          continue
        }
        const match = typeof value.resolution === "string" && value.resolution.match(/^(.+)@npm:([^:]+)$/)
        if (!match || match[2] !== value.version) { issues.push(`Unsupported Yarn resolution: ${key}`); continue }
        name = match[1]
      } else {
        const selector = selectors[0]!
        const at = selector.indexOf("@", 1)
        const spec = selector.slice(at + 1)
        const alias = spec.match(/^npm:(.+)@[^@]+$/)
        if (!alias && !(file === "bun.lockb" && spec.startsWith("catalog:")) && !/^[a-zA-Z0-9*^~<>=| .+-]+$/.test(spec)) { issues.push(`Unsupported Yarn resolution: ${key}`); continue }
        name = alias?.[1] ?? selector.slice(0, at)
        if (!registryArtifact(value.resolved, name, value.version, value.integrity)) { issues.push(`Unsupported Yarn artifact: ${selector.slice(0, at)}`); continue }
      }
      const entry = add(key, name, value.version, value.integrity)
      if (entry) for (const selector of selectors) byKey.set(selector, entry)
    }
    const configuration = file === "bun.lockb" ? options.bunCatalogs : options.yarnConfig
    const config = configuration === undefined ? {} : object(JSON.parse(yarnCatalogConfig(configuration)))
    const descriptor = (alias: string, spec: string): string | undefined => {
      if (!spec.startsWith("catalog:")) return spec
      const name = spec.slice("catalog:".length)
      const catalog = name ? object(object(config.catalogs)[name]) : object(config.catalog)
      return typeof catalog[alias] === "string" && !catalog[alias].startsWith("catalog:") ? catalog[alias] : undefined
    }
    const declaredLocal = result.isLocal
    result.isLocal = (project, alias, spec) => {
      const resolved = descriptor(alias, spec)
      return resolved !== undefined && declaredLocal(project, alias, resolved)
    }
    result.direct = (_project, alias, spec) => {
      const resolved = descriptor(alias, spec)
      if (resolved === undefined) return undefined
      if (file === "bun.lockb" && spec.startsWith("catalog:")) {
        const actual = resolved.match(/^npm:(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/)
        if (!actual && /[:/]/.test(resolved)) return undefined
        const entry = byKey.get(`${actual ? actual[1] : alias}@${spec}`)
        const range = actual ? actual[2] ?? "*" : resolved
        return entry && (!validRange(range) || satisfies(entry.version, range, { includePrerelease: true })) ? entry : undefined
      }
      const entry = byKey.get(`${alias}@${resolved}`) ?? byKey.get(`${alias}@npm:${resolved}`)
      // Bun's Yarn printer uses the actual package name for npm alias selectors.
      const actual = file === "bun.lockb" && resolved.match(/^npm:(@[^/]+\/[^@]+|[^@]+)@/)
      return entry ?? (actual ? byKey.get(`${actual[1]}@${resolved}`) : undefined)
    }
  } else throw new Error(`Unsupported lockfile: ${file}`)
  const direct = result.direct
  result.direct = (project, alias, spec) => result.isLocal(project, alias, spec) ? undefined : direct(project, alias, spec)
  return result
}
