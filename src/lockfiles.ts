import { parseSyml } from "@yarnpkg/parsers"
import { parseAllDocuments } from "yaml"
import ts from "typescript"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { assertExactVersion, assertPackageName } from "./identity.js"

export const lockfileNames = ["npm-shrinkwrap.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const
export type LockedPackage = { name: string; version: string; integrity?: string; locations: string[] }
export type Lockfile = {
  path: string; packages: LockedPackage[]; issues: string[]; workspaceRanges?: boolean
  direct(project: string, alias: string, spec: string): LockedPackage | undefined
  isLocal(project: string, alias: string, spec: string): boolean
}
type Data = Record<string, any>
const object = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}
export const declaredDependencies = (manifest: Data): Record<string, string> => ({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function selectLockfile(names: string[], packageManager?: string): string | undefined {
  let candidates = names.filter(name => (lockfileNames as readonly string[]).includes(name))
  if (candidates.includes("npm-shrinkwrap.json")) candidates = candidates.filter(name => name !== "package-lock.json")
  if (candidates.includes("bun.lock")) candidates = candidates.filter(name => name !== "bun.lockb")
  const manager = packageManager?.split("@")[0]
  const preferred = manager === "npm" ? ["npm-shrinkwrap.json", "package-lock.json"] : manager === "pnpm" ? ["pnpm-lock.yaml"] : manager === "yarn" ? ["yarn.lock"] : manager === "bun" ? ["bun.lock", "bun.lockb"] : []
  if (preferred.length && candidates.length) {
    const match = preferred.find(name => candidates.includes(name))
    if (!match) throw new Error(`No ${manager} lockfile found for packageManager ${packageManager}`)
    return match
  }
  if (candidates.length > 1) throw new Error(`Ambiguous lockfiles: ${candidates.join(", ")}; set packageManager in package.json`)
  return candidates[0]
}

export function parseLockfile(path: string, text: string): Lockfile {
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
  if (file === "bun.lockb") throw new Error("Unsupported binary bun.lockb; convert with bun install --save-text-lockfile --frozen-lockfile --lockfile-only")
  if (file === "package-lock.json" || file === "npm-shrinkwrap.json") {
    const lock = object(JSON.parse(text))
    if (![1, 2, 3].includes(lock.lockfileVersion)) throw new Error(`Unsupported npm lockfile version: ${lock.lockfileVersion}`)
    if (lock.packages) {
      for (const [location, raw] of Object.entries(object(lock.packages))) {
        const value = object(raw)
        if (!location.includes("node_modules/")) continue
        if (value.link) { localLocations.add(resolve(root, location)); continue }
        add(location, value.name ?? location.split("node_modules/").at(-1), value.version, value.integrity, location)
      }
    } else {
      const walk = (dependencies: Data, parent: string) => {
        for (const [name, raw] of Object.entries(dependencies)) {
          const value = object(raw)
          const location = `${parent}node_modules/${name}`
          add(location, name, value.version, value.integrity, location)
          walk(object(value.dependencies), `${location}/`)
        }
      }
      walk(object(lock.dependencies), "")
    }
  } else if (file === "pnpm-lock.yaml") {
    const documents = parseAllDocuments(text, { uniqueKeys: true })
    for (const document of documents) if (document.errors.length) throw document.errors[0]
    const lock = object(documents.at(-1)?.toJS({ maxAliasCount: 100 }))
    if (![5, 6, 9].includes(Math.floor(Number(lock.lockfileVersion)))) throw new Error(`Unsupported pnpm lockfile version: ${lock.lockfileVersion}`)
    const identity = (key: string) => {
      const clean = key.replace(/^\//, "").split("(")[0]!.split("_")[0]!
      const match = clean.match(/^(@[^/]+\/[^/@]+|[^/@]+)[@/]([^/]+)$/)
      return match ? { name: match[1]!, version: match[2]! } : undefined
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
  } else if (file === "bun.lock") {
    const parsed = ts.parseConfigFileTextToJson(path, text)
    if (parsed.error) throw new Error(`Invalid bun.lock: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`)
    const lock = object(parsed.config)
    if (![0, 1].includes(lock.lockfileVersion)) throw new Error(`Unsupported Bun lockfile version: ${lock.lockfileVersion}`)
    for (const [key, raw] of Object.entries(object(lock.packages))) {
      if (!Array.isArray(raw) || typeof raw[0] !== "string") { issues.push(`Unsupported Bun package: ${key}`); continue }
      const at = raw[0].lastIndexOf("@")
      const name = raw[0].slice(0, at), version = raw[0].slice(at + 1)
      if (version.startsWith("workspace:")) {
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
  } else if (file === "yarn.lock") {
    const lock = object(parseSyml(text))
    result.workspaceRanges = !lock.__metadata
    for (const [key, raw] of Object.entries(lock)) {
      if (key === "__metadata") continue
      const value = object(raw)
      const selectors = key.split(/,\s*/)
      let name: string | undefined
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
        if (!alias && !/^[a-zA-Z0-9*^~<>=| .+-]+$/.test(spec)) { issues.push(`Unsupported Yarn resolution: ${key}`); continue }
        name = alias?.[1] ?? selector.slice(0, at)
      }
      const entry = add(key, name, value.version, value.integrity)
      if (entry) for (const selector of selectors) byKey.set(selector, entry)
    }
    result.direct = (_project, alias, spec) => byKey.get(`${alias}@${spec}`) ?? byKey.get(`${alias}@npm:${spec}`)
  } else throw new Error(`Unsupported lockfile: ${file}`)
  const direct = result.direct
  result.direct = (project, alias, spec) => result.isLocal(project, alias, spec) ? undefined : direct(project, alias, spec)
  return result
}
