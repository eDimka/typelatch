import { realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { declaredDependencies, lockfileNames, parseLockfile, selectLockfile, type Lockfile } from "./lockfiles.js"
import { insideProject, projectBoundary, projectReader, type ProjectRead } from "./project-files.js"

type Dependency = { name: string; version: string; alias?: string }
const parsedLocks = new WeakMap<ProjectRead, Map<string, { text: string; lock: Lockfile }>>()
function parseObservedLock(read: ProjectRead, path: string, text: string): Lockfile {
  let cache = parsedLocks.get(read)
  if (!cache) { cache = new Map(); parsedLocks.set(read, cache) }
  const previous = cache.get(path)
  if (previous?.text === text) return previous.lock
  const lock = parseLockfile(path, text)
  cache.set(path, { text, lock })
  return lock
}

export async function resolveProjectLockfile(project: string, boundary: string, read: ProjectRead, override?: string): Promise<Lockfile | undefined> {
  project = resolve(project)
  boundary = resolve(boundary)
  if (!insideProject(boundary, project)) throw new Error(`Project is outside its boundary: ${project}`)
  if (override) {
    const path = resolve(override)
    if (!insideProject(boundary, path) || !insideProject(dirname(path), project)) throw new Error(`Lockfile must belong to the project or an ancestor within ${boundary}: ${path}`)
    if (!(lockfileNames as readonly string[]).includes(basename(path))) throw new Error(`Unsupported lockfile: ${path}`)
    const text = await read(path)
    if (text === undefined) throw new Error(`Lockfile not found: ${path}`)
    return parseObservedLock(read, path, text)
  }
  let directory = project
  let manager: string | undefined
  for (let depth = 0; depth < 64; depth++) {
    const manifest = await read(join(directory, "package.json"))
    if (!manager && manifest !== undefined) manager = JSON.parse(manifest).packageManager
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
          const text = await read(join(parent, "package.json"))
          if (text !== undefined) manager = JSON.parse(text).packageManager
          if (manager || parent === boundary) break
          parent = dirname(parent)
        }
      }
      const name = selected ?? selectLockfile([...files.keys()], manager)!
      return parseObservedLock(read, join(directory, name), files.get(name)!)
    }
    if (directory === boundary) return undefined
    directory = dirname(directory)
  }
  throw new Error("Lockfile ancestry exceeds 64 directories")
}

async function readProject(cwd: string, required: boolean, requested?: string): Promise<Dependency[]> {
  cwd = await realpath(resolve(cwd))
  const read = projectReader()
  const text = await read(join(cwd, "package.json"))
  if (text === undefined) {
    if (!required) return []
    throw new Error(`No package.json found in ${cwd}`)
  }
  const manifest = JSON.parse(text)
  const boundary = await projectBoundary(cwd, read)
  const lock = await resolveProjectLockfile(cwd, boundary, read)
  if (!lock) {
    if (!required) return []
    throw new Error(`No supported lockfile found; expected ${lockfileNames.join(", ")}`)
  }
  const dependencies: Dependency[] = []
  for (const [alias, spec] of Object.entries(declaredDependencies(manifest)).sort()) {
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
