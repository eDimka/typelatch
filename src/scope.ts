import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { insideProject, projectBoundary, projectReader } from "./project-files.js"

export type SavedScope = { root: string; path: string; projects: string[] }
const limit = 1000
const scopePath = (root: string) => join(root, ".typelatch", "scope.json")
const unique = (projects: string[]) => [...new Set(projects)].sort()
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

async function inspect(path: string) {
  try { return await lstat(path) } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

async function inspectScope(root: string): Promise<boolean> {
  const directory = join(root, ".typelatch")
  const info = await inspect(directory)
  if (!info) return false
  if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error(`Scope directory must be a real directory without symlinks: ${directory}`)
  const path = scopePath(root)
  const file = await inspect(path)
  if (!file) return false
  if (!file.isFile() || await realpath(path) !== path) throw new Error(`Scope must be a regular file without symlinks: ${path}`)
  if (file.size > 1024 * 1024) throw new Error(`Scope file exceeds 1 MiB: ${path}`)
  return true
}

function parseScope(root: string, text: string): SavedScope {
  const path = scopePath(root)
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`Invalid scope JSON: ${path}`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid scope object: ${path}`)
  const data = value as Record<string, unknown>
  if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error(`Scope must contain version 1 and a projects array: ${path}`)
  if (data.projects.length > limit) throw new Error(`Scope exceeds ${limit} projects: ${path}`)
  const projects = data.projects.map((project: unknown) => {
    if (typeof project !== "string" || !project || project.length > 4096 || /[\\\0]/.test(project) || isAbsolute(project) || project.split("/").includes("..")) {
      throw new Error(`Scope project must be a relative path within ${root}: ${String(project)}`)
    }
    const absolute = resolve(root, project)
    if (!insideProject(root, absolute)) throw new Error(`Scope project is outside ${root}: ${project}`)
    return absolute
  })
  return { root, path, projects: unique(projects) }
}

async function location(cwd: string): Promise<{ cwd: string; boundary: string; root: string | null }> {
  cwd = await realpath(resolve(cwd))
  const read = projectReader()
  let project = cwd
  let ancestor = cwd
  // Workspace patterns name packages, so resolve a source directory through its owning package.
  for (let depth = 0; depth < 64; depth++) {
    if (await inspect(join(ancestor, ".git")) || await read(join(ancestor, "package.json")) !== undefined) {
      project = ancestor
      break
    }
    if (dirname(ancestor) === ancestor) break
    ancestor = dirname(ancestor)
    if (depth === 63) throw new Error("Scope ancestry exceeds 64 directories")
  }
  const boundary = await projectBoundary(project, read)
  let directory = cwd
  while (insideProject(boundary, directory)) {
    if (await inspectScope(directory)) return { cwd, boundary, root: directory }
    if (directory === boundary) break
    directory = dirname(directory)
  }
  return { cwd, boundary, root: null }
}

async function loadScope(root: string | null): Promise<SavedScope | null> {
  return root === null ? null : parseScope(root, await readFile(scopePath(root), "utf8"))
}

export async function readScope(cwd: string): Promise<SavedScope | null> {
  return loadScope((await location(cwd)).root)
}

async function validateProject(root: string, path: string): Promise<string> {
  if (!insideProject(root, path)) throw new Error(`Scope project is outside ${root}: ${path}`)
  let canonical: string
  try { canonical = await realpath(path) } catch (error) {
    if (missing(error)) throw new Error(`Scope project directory does not exist: ${path}`)
    throw error
  }
  if (!insideProject(root, canonical)) throw new Error(`Scope project symlink escapes ${root}: ${path}`)
  if (!(await lstat(canonical)).isDirectory()) throw new Error(`Scope project must be a directory: ${path}`)
  const manifestPath = join(canonical, "package.json")
  const text = await projectReader()(manifestPath)
  if (text === undefined) throw new Error(`Scope project has no package.json: ${canonical}`)
  let manifest: unknown
  try { manifest = JSON.parse(text) } catch { throw new Error(`Scope project has invalid package.json: ${canonical}`) }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`Scope project has invalid package.json: ${canonical}`)
  return canonical
}

// Reading keeps stale entries available for removal; consumers validate before indexing.
export async function resolveScopeProjects(scope: SavedScope): Promise<string[]> {
  const root = await realpath(scope.root)
  if (scope.projects.length > limit) throw new Error(`Scope exceeds ${limit} projects: ${scope.path}`)
  const projects: string[] = []
  for (const project of scope.projects) projects.push(await validateProject(root, project))
  return unique(projects)
}

async function writeScope(scope: SavedScope): Promise<void> {
  const directory = dirname(scope.path)
  await inspectScope(scope.root)
  await mkdir(directory, { recursive: true })
  await inspectScope(scope.root)
  const temporary = join(directory, `.scope-${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const projects = scope.projects.map(project => relative(scope.root, project).split(sep).join("/") || ".")
    await file.writeFile(`${JSON.stringify({ version: 1, projects }, null, 2)}\n`)
    await file.sync()
    await file.close()
    await inspectScope(scope.root)
    await rename(temporary, scope.path)
  } catch (error) {
    await file.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function updateScope(cwd: string, action: "add" | "remove" | "set", paths: string[]): Promise<SavedScope> {
  if (paths.length > limit) throw new Error(`Scope exceeds ${limit} projects`)
  const current = await location(cwd)
  const saved = await loadScope(current.root)
  if (action === "remove" && !saved) throw new Error("No saved scope. Use scope add or scope set to create one.")
  const root = saved?.root ?? current.boundary
  const requested: string[] = []
  for (const path of paths) {
    if (!path || path.length > 4096 || path.includes("\0")) throw new Error("Scope project path must be a nonempty path")
    const absolute = resolve(current.cwd, path)
    if (!insideProject(root, absolute)) throw new Error(`Scope project is outside ${root}: ${path}`)
    if (action === "remove") {
      requested.push(absolute)
      // Also remove an existing internal alias while retaining removal of stale paths.
      const canonical = await realpath(absolute).catch(error => { if (missing(error)) return undefined; throw error })
      if (canonical && insideProject(root, canonical)) requested.push(canonical)
    } else requested.push(await validateProject(root, absolute))
  }
  const previous = saved?.projects ?? []
  const projects = unique(action === "set" ? requested : action === "add" ? [...previous, ...requested] : previous.filter(project => !requested.includes(project)))
  if (projects.length > limit) throw new Error(`Scope exceeds ${limit} projects`)
  const scope = { root, path: scopePath(root), projects }
  await writeScope(scope)
  return scope
}

export async function clearScope(cwd: string): Promise<{ root: string; path: string; removed: boolean }> {
  const current = await location(cwd)
  const root = current.root ?? current.boundary
  const path = scopePath(root)
  if (current.root !== null) {
    await inspectScope(root)
    await unlink(path)
  }
  return { root, path, removed: current.root !== null }
}
