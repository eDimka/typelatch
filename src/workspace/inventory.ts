import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { isUtf8 } from "node:buffer"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { assertExactVersion, assertPackageName } from "../identity.js"
import { brainHome } from "../paths.js"

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
}

export async function inventoryWorkspace(root: string, dependencies: boolean, signal: AbortSignal): Promise<Inventory> {
  const result: Inventory = { root, files: [], projects: [], configs: [], dependencies: [], selection: "filesystem", excluded: [], excludedCount: 0, issues: [] }
  const exclude = (path: string, reason: string) => {
    result.excludedCount++
    if (result.excluded.length < 30) result.excluded.push({ path, reason })
  }
  let paths: string[] = []
  try {
    const response = await exec("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", "."], { signal, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
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
    await walk(root)
  }
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
      if (info.size > 1_000_000) { exclude(path, "file exceeds 1 MB"); result.issues.push(`File exceeds 1 MB: ${rel}`); continue }
      bytes += info.size
      if (bytes > MAX_BYTES) { result.issues.push("Workspace text inventory exceeds 64 MiB"); break }
      const data = await readFile(path)
      if (data.includes(0) || !isUtf8(data)) { exclude(path, "binary or non UTF8"); continue }
      const text = data.toString("utf8")
      const searchable = !/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(basename(path))
      if (!searchable) exclude(path, "dependency lockfile; identity inventory only")
      result.files.push({ path, text, hash: hash(text), searchable })
      if (basename(path) === "package.json") result.projects.push(dirname(path))
      if (/^tsconfig(?:\..+)?\.json$/.test(basename(path))) result.configs.push(path)
    } catch (error) { result.issues.push(`Cannot read ${rel}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (dependencies) await inventoryDependencies(result, signal)
  return result
}

async function inventoryDependencies(inventory: Inventory, signal: AbortSignal): Promise<void> {
  const locations = new Map<string, Dependency>()
  // Lock entries are candidates only. An installed manifest at the same location takes precedence.
  for (const file of inventory.files.filter(file => /(?:package-lock|npm-shrinkwrap)\.json$/.test(file.path))) {
    try {
      const lock = JSON.parse(file.text)
      if (!lock.packages) { inventory.issues.push(`Dependency inventory requires npm lockfile version 2 or 3: ${file.path}`); continue }
      for (const [location, raw] of Object.entries(lock.packages)) {
        signal.throwIfAborted()
        const value = raw as { name?: string; version?: string; integrity?: string; link?: boolean }
        if (!location || value.link || !value.version || !location.includes("node_modules/")) continue
        const path = resolve(dirname(file.path), location)
        if (!inside(inventory.root, path)) { inventory.issues.push(`Lock dependency escapes workspace: ${location}`); continue }
        const name = value.name ?? location.split("node_modules/").at(-1)!
        assertPackageName(name); assertExactVersion(value.version)
        locations.set(path, { package: name, version: value.version, roots: [path], identity: "lockfile", installed: false, ...(value.integrity ? { integrity: value.integrity } : {}) })
      }
    } catch (error) { inventory.issues.push(`Cannot inventory ${file.path}: ${error instanceof Error ? error.message : String(error)}`) }
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
      for (const name of declared) {
        let directory = dirname(file.path)
        let found = false
        while (inside(inventory.root, directory)) {
          if (locations.has(join(directory, "node_modules", name))) { found = true; break }
          if (directory === inventory.root) break
          directory = dirname(directory)
        }
        if (!found && !inventory.projects.some(project => {
          const local = inventory.files.find(item => item.path === join(project, "package.json"))
          try { return local && JSON.parse(local.text).name === name } catch { return false }
        })) inventory.issues.push(`No exact installed or npm locked identity for ${name} in ${dirname(file.path)}`)
      }
    } catch { inventory.issues.push(`Invalid package manifest: ${file.path}`) }
  }
}
