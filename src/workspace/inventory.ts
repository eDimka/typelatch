import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { isUtf8 } from "node:buffer"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { Minimatch } from "minimatch"
import { satisfies } from "semver"
import { assertExactVersion, assertPackageName } from "../identity.js"
import { brainHome } from "../paths.js"
import { declaredDependencies, lockfileNames, type Lockfile } from "../lockfiles.js"
import { resolveProjectLockfile } from "../project.js"
import { readScope, resolveScopeProjects } from "../scope.js"
import { matchesWorkspace, workspacePatterns } from "../project-files.js"

const exec = promisify(execFile)
const excludedDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".typelatch", ".libbrain", "artifacts", "_site"])
const MAX_FILES = 20_000
const MAX_BYTES = 64 * 1024 * 1024
export const hash = (text: string) => createHash("sha256").update(text).digest("hex")
export const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export type WorkspaceFile = { path: string; text: string; hash: string; searchable: boolean }
export type Dependency = {
  package: string; version: string; roots: string[]; identity: "installed" | "lockfile"
  installed: boolean; integrity?: string
}
export type Inventory = {
  root: string; files: WorkspaceFile[]; projects: string[]; configs: string[]; dependencies: Dependency[]
  selection: string; excluded: Array<{ path: string; reason: string }>; excludedCount: number; issues: string[]
  savedScope?: { path: string; root: string; projects: string[]; sourceRoots: string[]; dependencyPolicy: "direct"; completeness: string }
}

export async function inventoryWorkspace(root: string, dependencies: boolean, signal: AbortSignal): Promise<Inventory> {
  const result: Inventory = { root, files: [], projects: [], configs: [], dependencies: [], selection: "filesystem", excluded: [], excludedCount: 0, issues: [] }
  // Re-read the saved selection for every request, including requests in a retained worker.
  const saved = await readScope(root)
  const selectedProjects = saved ? await resolveScopeProjects(saved) : undefined
  const selectedRoots = selectedProjects?.flatMap(project => inside(root, project) ? [project] : inside(project, root) ? [root] : [])
  const sourceRoots = selectedRoots ? [...new Set(selectedRoots)].filter(path => !selectedRoots.some(parent => parent !== path && inside(parent, path))) : [root]
  const metadata = new Set<string>()
  if (saved) {
    result.savedScope = { path: saved.path, root: saved.root, projects: selectedProjects!, sourceRoots, dependencyPolicy: "direct",
      completeness: "Coverage applies only to selected source subtrees and the selected projects' direct dependencies within workspaceRoot" }
    result.selection = "Saved project scope intersected with workspaceRoot"
    if (!sourceRoots.length) return result
    for (const project of sourceRoots) {
      let directory = dirname(project)
      while (inside(root, directory) && !sourceRoots.some(source => inside(source, directory))) {
        for (const name of ["package.json", ...lockfileNames]) metadata.add(join(directory, name))
        if (directory === root) break
        directory = dirname(directory)
      }
    }
  }
  const exclude = (path: string, reason: string) => {
    result.excludedCount++
    if (result.excluded.length < 30) result.excluded.push({ path, reason })
  }
  let paths: string[] = []
  try {
    const pathspecs = saved ? [...sourceRoots, ...metadata].map(path => relative(root, path) || ".") : ["."]
    const response = await exec("git", ["--literal-pathspecs", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", ...pathspecs], { signal, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
    paths = response.stdout.split("\0").filter(Boolean).map(path => resolve(root, path))
    result.selection = "Git tracked and unignored files, with generated directories and source symlinks excluded"
  } catch {
    signal.throwIfAborted()
    result.selection = "Filesystem traversal; Git ignore rules unavailable"
    result.issues.push("Git file selection unavailable; filesystem traversal does not apply Git ignore rules")
    const walk = async (directory: string): Promise<void> => {
      signal.throwIfAborted()
      if (paths.length > MAX_FILES) return
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (excludedDirectories.has(entry.name)) exclude(path, "generated or dependency directory")
          else await walk(path)
        } else paths.push(path)
        if (paths.length > MAX_FILES) break
      }
    }
    for (const directory of sourceRoots) await walk(directory)
    for (const path of metadata) {
      const info = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (info) paths.push(path)
    }
  }
  if (saved) result.selection += "; saved project scope applied before file enumeration; ancestor manifests and lockfiles provide identity metadata only"
  paths = [...new Set(paths)].sort()
  if (paths.length > MAX_FILES) result.issues.push(`File inventory limited to ${MAX_FILES} entries`)
  let bytes = 0
  const dataHome = await realpath(brainHome()).catch(() => resolve(brainHome()))
  for (const path of paths.slice(0, MAX_FILES)) {
    signal.throwIfAborted()
    const rel = relative(root, path)
    if (!inside(root, path) || inside(dataHome, path) || rel.split(sep).some(part => excludedDirectories.has(part))) { exclude(path, "generated or dependency directory"); continue }
    if (/^(?:\.env(?:\..*)?|\.DS_Store)$/.test(basename(path)) || /\.(?:pem|key|p12|pfx|db|tgz|zip|gz|png|jpe?g|gif|webp|pdf|woff2?|mp[34])$/i.test(path)) { exclude(path, "excluded file type"); continue }
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) { exclude(path, "symlink"); continue }
      if (!info.isFile()) { exclude(path, "not a regular file"); continue }
      // Reject symlink ancestors too, including tracked files replaced by a linked directory.
      if (await realpath(path) !== path) { exclude(path, "symlink"); continue }
      const sizeLimit = saved && (lockfileNames as readonly string[]).includes(basename(path)) ? 16 * 1024 * 1024 : 1_000_000
      if (info.size > sizeLimit) {
        const label = sizeLimit === 1_000_000 ? "1 MB" : "16 MiB"
        exclude(path, `file exceeds ${label}`); result.issues.push(`File exceeds ${label}: ${rel}`); continue
      }
      bytes += info.size
      if (bytes > MAX_BYTES) { result.issues.push("Workspace text inventory exceeds 64 MiB"); break }
      const data = await readFile(path)
      if (data.includes(0) || !isUtf8(data)) {
        exclude(path, "binary or non UTF8")
        if (basename(path) === "bun.lockb") result.files.push({ path, text: "", hash: createHash("sha256").update(data).digest("hex"), searchable: false })
        continue
      }
      const text = data.toString("utf8")
      const source = !saved || sourceRoots.some(directory => inside(directory, path))
      const searchable = source && !/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(basename(path))
      if (!searchable) exclude(path, source ? "dependency lockfile; identity inventory only" : "ancestor metadata; identity inventory only")
      result.files.push({ path, text, hash: hash(text), searchable })
      if (basename(path) === "package.json" && (!saved || selectedProjects!.includes(dirname(path)))) result.projects.push(dirname(path))
      if (source && /^tsconfig(?:\..+)?\.json$/.test(basename(path))) result.configs.push(path)
    } catch (error) { result.issues.push(`Cannot read ${rel}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (dependencies) {
    if (saved) await inventoryScopedDependencies(result, signal)
    else await inventoryDependencies(result, signal)
  }
  return result
}

async function inventoryScopedDependencies(inventory: Inventory, signal: AbortSignal): Promise<void> {
  const observed = new Map(inventory.files.map(file => [file.path, file.text]))
  const read = async (path: string) => { signal.throwIfAborted(); return observed.get(path) }
  const grouped = new Map<string, Dependency>()
  const workspaces = new Map<string, Promise<Array<{ name: string; version: string }>>>()
  const localWorkspace = async (root: string, alias: string, spec: string) => {
    let manifests = workspaces.get(root)
    if (!manifests) {
      manifests = scopedWorkspaceMetadata(root, inventory, signal).catch(error => {
        signal.throwIfAborted()
        inventory.issues.push(`Cannot corroborate local workspace identities: ${error instanceof Error ? error.message : String(error)}`)
        return []
      })
      workspaces.set(root, manifests)
    }
    return (await manifests).some(manifest => manifest.name === alias && satisfies(manifest.version, spec))
  }
  let count = 0
  for (const project of inventory.savedScope!.projects.filter(project => inside(inventory.root, project))) {
    signal.throwIfAborted()
    const text = observed.get(join(project, "package.json"))
    if (text === undefined) { inventory.issues.push(`Selected project manifest excluded or unavailable: ${project}`); continue }
    let boundary = project
    while (boundary !== inventory.root) {
      const git = await lstat(join(boundary, ".git")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (git) break
      boundary = dirname(boundary)
    }
    let lock: Lockfile | undefined
    try { lock = await resolveProjectLockfile(project, boundary, read) }
    catch (error) { inventory.issues.push(`Cannot inventory lockfile in ${project}: ${error instanceof Error ? error.message : String(error)}`) }
    let declared: Record<string, string>
    try { declared = declaredDependencies(JSON.parse(text)) }
    catch { inventory.issues.push(`Invalid package manifest: ${join(project, "package.json")}`); continue }
    for (const [alias, spec] of Object.entries(declared).sort()) {
      signal.throwIfAborted()
      if (++count > 2000) { inventory.issues.push("Dependency inventory limited to 2000 direct declarations"); break }
      try {
        assertPackageName(alias)
        if (typeof spec !== "string") throw new Error("Dependency specifier must be a string")
        if (lock?.isLocal(project, alias, spec) || /^(?:workspace:|link:|file:|portal:)/.test(spec)) continue
        const locked = lock?.direct(project, alias, spec)
        if (lock?.workspaceRanges && await localWorkspace(dirname(lock.path), alias, spec)) continue
        let dependency: Dependency | undefined
        let installed = false
        let directory = project
        while (inside(boundary, directory)) {
          const path = join(directory, "node_modules", alias)
          const entry = await lstat(path).catch(error => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
            throw error
          })
          if (entry) {
            installed = true
            const actual = await realpath(path)
            if (!inside(inventory.root, actual)) throw new Error(`Linked dependency outside workspace: ${path}`)
            // An installed workspace link does not opt its source into the saved selection.
            if (!relative(inventory.root, actual).split(sep).includes("node_modules")) break
            const manifestPath = join(actual, "package.json")
            if (!inside(inventory.root, await realpath(manifestPath))) throw new Error(`Dependency manifest outside workspace: ${manifestPath}`)
            const info = await lstat(manifestPath)
            if (!info.isFile() || info.size > 1_000_000) throw new Error(`Expected dependency manifest smaller than 1 MB: ${manifestPath}`)
            const value = JSON.parse(await readFile(manifestPath, "utf8"))
            assertPackageName(value.name); assertExactVersion(value.version)
            const matches = locked && locked.name === value.name && locked.version === value.version
            if (locked && !matches) inventory.issues.push(`Installed dependency differs from lockfile: ${path}`)
            dependency = { package: value.name, version: value.version, roots: [path], identity: "installed", installed: true,
              ...(matches && locked.integrity ? { integrity: locked.integrity } : {}) }
            break
          }
          if (directory === boundary) break
          directory = dirname(directory)
        }
        if (!installed && locked) dependency = { package: locked.name, version: locked.version, roots: [join(project, "node_modules", alias)], identity: "lockfile", installed: false,
          ...(locked.integrity ? { integrity: locked.integrity } : {}) }
        if (!installed && !locked) inventory.issues.push(`No exact installed or locked identity for ${alias} in ${project}`)
        if (dependency) {
          const key = JSON.stringify([dependency.package, dependency.version, dependency.identity, dependency.integrity])
          const previous = grouped.get(key)
          if (previous) previous.roots = [...new Set([...previous.roots, ...dependency.roots])]
          else grouped.set(key, dependency)
        }
      } catch (error) { inventory.issues.push(`Cannot identify dependency ${alias} in ${project}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (count > 2000) break
  }
  inventory.dependencies = [...grouped.values()].sort((a, b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version))
}

// Yarn Classic omits local range dependencies from its lockfile. Read only declared
// workspace manifests to corroborate those identities, without selecting their source.
async function scopedWorkspaceMetadata(root: string, inventory: Inventory, signal: AbortSignal): Promise<Array<{ name: string; version: string }>> {
  const text = inventory.files.find(file => file.path === join(root, "package.json"))?.text
  if (text === undefined) return []
  const patterns = workspacePatterns(JSON.parse(text))
  const includes = patterns.filter(pattern => !pattern.startsWith("!")).map(pattern => new Minimatch(pattern, { dot: false, partial: true }))
  let paths: string[] = []
  let directories = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    signal.throwIfAborted()
    if (++directories > 20_000 || depth > 64) throw new Error("Workspace identity metadata exceeds directory limits")
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || excludedDirectories.has(entry.name)) continue
      const path = join(directory, entry.name)
      const rel = relative(root, path).split(sep).join("/")
      if (!includes.some(pattern => pattern.match(rel))) continue
      if (await realpath(path) !== path || await lstat(join(path, ".git")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })) continue
      if (matchesWorkspace(rel, patterns)) {
        const manifest = join(path, "package.json")
        const info = await lstat(manifest).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        })
        if (info?.isFile()) paths.push(manifest)
        if (paths.length > 1000) throw new Error("Workspace identity metadata exceeds 1000 manifests")
      }
      await visit(path, depth + 1)
    }
  }
  if (patterns.length) await visit(root, 0)
  if (paths.length && inventory.selection.startsWith("Git tracked")) {
    const response = await exec("git", ["--literal-pathspecs", "-C", inventory.root, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", ...paths.map(path => relative(inventory.root, path))], { signal, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
    const selected = new Set(response.stdout.split("\0").filter(Boolean).map(path => resolve(inventory.root, path)))
    paths = paths.filter(path => selected.has(path))
  }
  const manifests: Array<{ name: string; version: string }> = []
  let bytes = 0
  for (const path of paths) {
    signal.throwIfAborted()
    const info = await lstat(path)
    if (!info.isFile() || await realpath(path) !== path) continue
    if (info.size > 1_000_000 || (bytes += info.size) > MAX_BYTES) throw new Error("Workspace identity metadata exceeds file size limits")
    let manifest
    try { manifest = JSON.parse(await readFile(path, "utf8")) } catch { continue }
    if (typeof manifest?.name === "string" && typeof manifest.version === "string") manifests.push({ name: manifest.name, version: manifest.version })
  }
  return manifests
}

async function inventoryDependencies(inventory: Inventory, signal: AbortSignal): Promise<void> {
  const locations = new Map<string, Dependency>()
  const locks = new Map<string, Lockfile>()
  const projectLocks = new Map<string, Lockfile>()
  const candidates = new Map<string, Dependency>()
  const lockFiles = inventory.files.filter(file => (lockfileNames as readonly string[]).includes(basename(file.path)))
  const observed = new Map(inventory.files.map(file => [file.path, file.text]))
  const read = async (path: string) => { signal.throwIfAborted(); return observed.get(path) }
  const boundaries = new Map<string, string>()
  const boundaryFor = async (project: string) => {
    const visited: string[] = []
    let directory = project
    let boundary = inventory.root
    while (inside(inventory.root, directory)) {
      signal.throwIfAborted()
      const cached = boundaries.get(directory)
      if (cached) { boundary = cached; break }
      visited.push(directory)
      // Only inspect the Git marker's presence; never read or follow its target.
      const git = await lstat(join(directory, ".git")).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      })
      if (git || directory === inventory.root) { boundary = directory; break }
      directory = dirname(directory)
    }
    for (const path of visited) boundaries.set(path, boundary)
    return boundary
  }
  // Reuse sync ownership rules without reading ignored files or leaving the observed root.
  for (const directory of new Set([...inventory.projects, ...lockFiles.map(file => dirname(file.path))])) {
    try {
      const lock = await resolveProjectLockfile(directory, await boundaryFor(directory), read)
      if (!lock) continue
      projectLocks.set(directory, lock)
      locks.set(lock.path, lock)
    } catch (error) { inventory.issues.push(`Cannot inventory lockfile in ${directory}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const competing = new Set<string>()
  const lockDirectories = new Set<string>()
  for (const lock of locks.values()) {
    const directory = dirname(lock.path)
    if (lockDirectories.has(directory)) competing.add(directory)
    lockDirectories.add(directory)
  }
  const repositoryBoundaries = [...new Set(boundaries.values())]
  for (const lock of [...locks.values()].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))) {
    const nestedRepositories = repositoryBoundaries.filter(boundary => boundary !== dirname(lock.path) && inside(dirname(lock.path), boundary))
    inventory.issues.push(...lock.issues.map(issue => `${issue}: ${lock.path}`))
    for (const entry of lock.packages) {
      signal.throwIfAborted()
      const paths = entry.locations.filter(path => !nestedRepositories.some(boundary => inside(boundary, path)))
      const dependency: Dependency = { package: entry.name, version: entry.version, roots: paths.length ? paths : [lock.path], identity: "lockfile", installed: false,
        ...(entry.integrity ? { integrity: entry.integrity } : {}) }
      for (const path of paths) locations.set(path, dependency)
      // Distinct selected lock trees can describe different artifacts at the same installation path.
      if (!paths.length || competing.has(dirname(lock.path))) candidates.set(`${lock.path}#${entry.name}@${entry.version}:${entry.integrity ?? ""}`, { ...dependency, roots: [lock.path] })
    }
  }
  // Lock locations are candidates. Installed manifests take precedence below.
  for (const file of inventory.files.filter(file => basename(file.path) === "package.json")) {
    try {
      const lock = projectLocks.get(dirname(file.path))
      if (!lock) continue
      for (const [alias, spec] of Object.entries(declaredDependencies(JSON.parse(file.text)))) {
        const entry = lock.direct(dirname(file.path), alias, spec)
        if (!entry) continue
        assertPackageName(alias)
        const path = join(dirname(file.path), "node_modules", alias)
        locations.set(path, { package: entry.name, version: entry.version, roots: [path], identity: "lockfile", installed: false,
          ...(entry.integrity ? { integrity: entry.integrity } : {}) })
      }
    } catch (error) { inventory.issues.push(`Cannot identify locked dependencies for ${file.path}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const visited = new Set<string>()
  let count = 0
  const scan = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    if (count >= 2000) return
    let canonical: string
    try { canonical = await realpath(directory) } catch { return }
    if (!inside(inventory.root, canonical)) { inventory.issues.push(`Dependency directory outside workspace: ${directory}`); return }
    if (visited.has(canonical)) return
    visited.add(canonical)
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal.throwIfAborted()
      if (entry.name.startsWith(".")) continue
      const path = join(directory, entry.name)
      if (entry.name.startsWith("@")) { await scan(path); continue }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (count++ >= 2000) break
      try {
        const actual = await realpath(path)
        if (!inside(inventory.root, actual)) { inventory.issues.push(`Linked dependency outside workspace: ${path}`); locations.delete(path); continue }
        const value = JSON.parse(await readFile(join(actual, "package.json"), "utf8"))
        // Local workspace packages are searched as source, not as registry artifacts.
        if (!relative(inventory.root, actual).split(sep).includes("node_modules")) { locations.delete(path); continue }
        assertPackageName(value.name); assertExactVersion(value.version)
        const locked = locations.get(path)
        if (locked && (locked.package !== value.name || locked.version !== value.version)) inventory.issues.push(`Installed dependency differs from lockfile: ${path}`)
        locations.set(path, { package: value.name, version: value.version, roots: [path], identity: "installed", installed: true,
          ...(locked && locked.package === value.name && locked.version === value.version && locked.integrity ? { integrity: locked.integrity } : {}) })
        await scan(join(actual, "node_modules"))
        // pnpm links point into a virtual store whose sibling directory contains dependencies.
        if (basename(dirname(actual)) === "node_modules") await scan(dirname(actual))
        else if (basename(dirname(actual)).startsWith("@") && basename(dirname(dirname(actual))) === "node_modules") await scan(dirname(dirname(actual)))
      } catch (error) { locations.delete(path); inventory.issues.push(`Cannot identify dependency ${path}: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }
  for (const project of new Set([inventory.root, ...inventory.projects])) await scan(join(project, "node_modules"))
  const artifactKey = (item: Dependency) => JSON.stringify([item.package, item.version, item.integrity])
  const locatedArtifacts = new Set([...locations.values()].map(artifactKey))
  for (const [key, candidate] of candidates) {
    if (!locatedArtifacts.has(artifactKey(candidate))) locations.set(key, candidate)
  }
  if (count >= 2000 || locations.size > 2000) inventory.issues.push("Dependency inventory limited to 2000 installations")
  const grouped = new Map<string, Dependency>()
  for (const item of [...locations.values()].slice(0, 2000)) {
    const key = JSON.stringify([item.package, item.version, item.identity, item.integrity])
    const prior = grouped.get(key)
    if (prior) prior.roots.push(...item.roots)
    else grouped.set(key, item)
  }
  inventory.dependencies = [...grouped.values()].sort((a, b) => a.package.localeCompare(b.package) || a.version.localeCompare(b.version))
  for (const file of inventory.files.filter(file => basename(file.path) === "package.json")) {
    try {
      const manifest = JSON.parse(file.text)
      const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })
      const boundary = boundaries.get(dirname(file.path)) ?? dirname(file.path)
      for (const name of declared) {
        let directory = dirname(file.path)
        let found = false
        while (inside(boundary, directory)) {
          if (locations.has(join(directory, "node_modules", name))) { found = true; break }
          if (directory === boundary) break
          directory = dirname(directory)
        }
        if (!found && !inventory.projects.some(project => {
          if (boundaries.get(project) !== boundary) return false
          const local = inventory.files.find(item => item.path === join(project, "package.json"))
          try { return local && JSON.parse(local.text).name === name } catch { return false }
        })) inventory.issues.push(`No exact installed or locked identity for ${name} in ${dirname(file.path)}`)
      }
    } catch { inventory.issues.push(`Invalid package manifest: ${file.path}`) }
  }
}
