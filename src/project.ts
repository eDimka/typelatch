import { realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { lockfileNames, parseLockfile, selectLockfile, yarnCatalogConfig, type Lockfile } from "./lockfiles.js"
import { insideProject, matchesWorkspace, workspacePatterns, projectBoundary, projectReader, type ProjectRead } from "./project-files.js"
import { readProjectManifest, type ProjectManifest } from "./project-manifest.js"

type Dependency = { name: string; version: string; alias?: string }
const parsedLocks = new WeakMap<ProjectRead, Map<string, { text: string; yarnConfig: string | undefined; bunCatalogs: string | undefined; lock: Lockfile }>>()
async function parseObservedLock(read: ProjectRead, path: string, text: string): Promise<Lockfile> {
  let cache = parsedLocks.get(read)
  if (!cache) { cache = new Map(); parsedLocks.set(read, cache) }
  const previous = cache.get(path)
  const observedConfig = basename(path) === "yarn.lock" ? await read(join(dirname(path), ".yarnrc.yml")) : undefined
  const yarnConfig = observedConfig === undefined ? undefined : yarnCatalogConfig(observedConfig)
  const packageText = basename(path) === "bun.lockb" ? await read(join(dirname(path), "package.json")) : undefined
  const packageData = packageText === undefined ? undefined : JSON.parse(packageText)
  const workspaceData = packageData?.workspaces && !Array.isArray(packageData.workspaces) ? packageData.workspaces : undefined
  const bunCatalogs = packageData === undefined ? undefined : yarnCatalogConfig(JSON.stringify({
    catalog: workspaceData?.catalog ?? packageData.catalog, catalogs: workspaceData?.catalogs ?? packageData.catalogs,
  }))
  if (previous?.text === text && previous.yarnConfig === yarnConfig && previous.bunCatalogs === bunCatalogs) return previous.lock
  const lock = parseLockfile(path, text, { ...(yarnConfig !== undefined ? { yarnConfig } : {}), ...(bunCatalogs !== undefined ? { bunCatalogs } : {}) })
  cache.set(path, { text, yarnConfig, bunCatalogs, lock })
  return lock
}

export async function resolveProjectLockfile(project: string, boundary: string, read: ProjectRead, override?: string): Promise<Lockfile | undefined> {
  project = resolve(project)
  boundary = resolve(boundary)
  if (!insideProject(boundary, project)) throw new Error(`Project is outside its boundary: ${project}`)
  const manifest = await readEffectiveManifest(project, boundary, read)
  const parseSelected = (path: string, text: string) => {
    if (manifest?.npmImports.size && basename(path) !== "deno.lock") throw new Error(`Deno npm imports require deno.lock: ${manifest.path}`)
    return parseObservedLock(read, path, text)
  }
  if (override) {
    const path = resolve(override)
    if (!insideProject(boundary, path) || !insideProject(dirname(path), project)) throw new Error(`Lockfile must belong to the project or an ancestor within ${boundary}: ${path}`)
    if (!(lockfileNames as readonly string[]).includes(basename(path))) throw new Error(`Unsupported lockfile: ${path}`)
    const text = await read(path)
    if (text === undefined) throw new Error(`Lockfile not found: ${path}`)
    return parseSelected(path, text)
  }
  let directory = project
  let manager: string | undefined
  for (let depth = 0; depth < 64; depth++) {
    const manifest = await readProjectManifest(directory, read)
    if (manifest?.lock === false) throw new Error(`Deno lockfile is disabled: ${manifest.path}`)
    const lockIssue = manifest?.issues.find(issue => issue.startsWith("Unsupported Deno lockfile"))
    if (lockIssue) throw new Error(lockIssue)
    if (!manager && manifest) manager = manifest.data.packageManager
    const files = new Map<string, string>()
    for (const name of lockfileNames) {
      const text = await read(join(directory, name))
      if (text !== undefined) files.set(name, text)
    }
    if (files.size) {
      let selected: string | undefined
      if (!manager) {
        try { selected = selectLockfile([...files.keys()]) } catch { /* Ancestor metadata may resolve competing managers. */ }
      }
      // An independent nested lock owns its project; parent managers only help disambiguate competing locks.
      if (!manager && !selected) {
        let parent = dirname(directory)
        while (insideProject(boundary, parent) && parent !== directory) {
          const manifest = await readProjectManifest(parent, read)
          if (manifest) manager = manifest.data.packageManager
          if (manager || parent === boundary) break
          parent = dirname(parent)
        }
      }
      const name = selected ?? selectLockfile([...files.keys()], manager)!
      return parseSelected(join(directory, name), files.get(name)!)
    }
    if (directory === boundary) return undefined
    directory = dirname(directory)
  }
  throw new Error("Lockfile ancestry exceeds 64 directories")
}

export async function readEffectiveManifest(project: string, boundary: string, read: ProjectRead): Promise<ProjectManifest | undefined> {
  const manifest = await readProjectManifest(project, read)
  if (!manifest) return undefined
  let directory = project
  while (directory !== boundary && insideProject(boundary, directory)) {
    directory = dirname(directory)
    const ancestor = await readProjectManifest(directory, read)
    if (!ancestor?.deno || !matchesWorkspace(relative(directory, project).split(sep).join("/"), workspacePatterns(ancestor.data))) continue
    const dependencies = { ...ancestor.denoImports, ...manifest.dependencies }
    const issues = [...ancestor.issues, ...manifest.issues]
    for (const [alias, spec] of Object.entries(ancestor.denoImports)) {
      if (alias in manifest.dependencies && !(alias in manifest.denoImports) && manifest.dependencies[alias] !== spec) {
        issues.push(`Conflicting package.json and inherited Deno import ${alias}: ${manifest.path}`)
        delete dependencies[alias]
      }
    }
    const npmImports = new Set([...Object.keys(ancestor.denoImports).filter(alias => ancestor.denoImports[alias]!.startsWith("npm:") && !(alias in manifest.dependencies)), ...manifest.npmImports])
    return { ...manifest, dependencies, npmImports, deno: true, data: { ...manifest.data, packageManager: manifest.data.packageManager ?? "deno" }, issues }
  }
  return manifest
}

async function readProject(cwd: string, required: boolean, requested?: string): Promise<Dependency[]> {
  cwd = await realpath(resolve(cwd))
  const read = projectReader()
  const boundary = await projectBoundary(cwd, read)
  const manifest = await readEffectiveManifest(cwd, boundary, read)
  if (manifest === undefined) {
    if (!required) return []
    throw new Error(`No package.json, deno.json or deno.jsonc found in ${cwd}`)
  }
  if (manifest.issues.length) throw new Error(manifest.issues.join("; "))
  const lock = await resolveProjectLockfile(cwd, boundary, read)
  if (!lock) {
    if (!required) return []
    throw new Error(`No supported lockfile found; expected ${lockfileNames.join(", ")}`)
  }
  const dependencies: Dependency[] = []
  for (const [alias, spec] of Object.entries(manifest.dependencies).sort()) {
    if (requested && alias !== requested) continue
    if (lock.isLocal(cwd, alias, spec)) continue
    const entry = lock.direct(cwd, alias, spec)
    if (!entry) throw new Error(`No exact locked registry identity for ${alias} in ${lock.path}`)
    dependencies.push({ name: entry.name, version: entry.version, ...(alias !== entry.name ? { alias } : {}) })
  }
  return dependencies
}

export async function projectDependencies(cwd: string): Promise<Dependency[]> {
  return readProject(cwd, true)
}

export async function exactProjectVersion(cwd: string, name: string): Promise<string | null> {
  return (await exactProjectDependency(cwd, name))?.version ?? null
}

export async function exactProjectDependency(cwd: string, name: string): Promise<Dependency | null> {
  return (await readProject(cwd, false, name))[0] ?? null
}
