import { existsSync } from "node:fs"
import { lstat, readdir, realpath } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { Minimatch } from "minimatch"
import { satisfies } from "semver"
import { openBrainDatabase } from "./database.js"
import { declaredDependencies, lockfileNames } from "./lockfiles.js"
import { brainPath } from "./paths.js"
import { readScope, resolveScopeProjects, type SavedScope } from "./scope.js"
import { resolveProjectLockfile } from "./project.js"
import { insideProject, matchesWorkspace, projectBoundary, projectReader, workspacePatterns, type ProjectRead } from "./project-files.js"

export type SyncTarget = {
  name: string; version: string; integrity?: string
  sources: Array<{ project: string; lockfile: string; alias: string }>
  cache: "missing" | "ready" | "invalid"; reason?: string
}
export type SyncPlan = {
  ready: boolean
  force: boolean
  savedScope: SavedScope | null
  projects: Array<{ root: string; lockfile: string | null }>
  targets: SyncTarget[]
  skipped: Array<{ project: string; name: string; reason: string }>
  issues: string[]
}
export type SyncOptions = { cwd: string; projects?: string[]; workspaces?: boolean; lockfile?: string; packages?: string[]; force?: boolean }
const excludedDirectories = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".typelatch", "artifacts", "_site"])
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const packageName = (alias: string, spec: string) => spec.startsWith("npm:") ? spec.slice(4).match(/^(@[^/]+\/[^@]+|[^@]+)(?:@|$)/)?.[1] ?? alias : alias

async function discoverWorkspaces(root: string, read: ProjectRead): Promise<string[]> {
  const text = await read(join(root, "package.json"))
  if (text === undefined) throw new Error(`No package.json found in ${root}`)
  const patterns = workspacePatterns(JSON.parse(text), await read(join(root, "pnpm-workspace.yaml")))
  const include = patterns.filter(pattern => !pattern.startsWith("!")).map(pattern => new Minimatch(pattern, { dot: false, partial: true }))
  const projects = [root]
  let directories = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (++directories > 20_000 || depth > 64) throw new Error("Workspace discovery exceeds directory limits")
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || excludedDirectories.has(entry.name)) continue
      const path = join(directory, entry.name)
      const rel = relative(root, path).split(sep).join("/")
      if (!include.some(pattern => pattern.match(rel))) continue
      if (matchesWorkspace(rel, patterns) && await read(join(path, "package.json")) !== undefined) projects.push(path)
      if (projects.length > 1000) throw new Error("Workspace discovery exceeds 1000 projects")
      await visit(path, depth + 1)
    }
  }
  if (patterns.length) await visit(root, 0)
  return projects
}

function cacheState(target: SyncTarget): Pick<SyncTarget, "cache" | "reason"> {
  const path = brainPath(target.name, target.version)
  if (!existsSync(path)) return { cache: "missing" }
  try {
    const db = openBrainDatabase(path)
    try {
      const values = Object.fromEntries((db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value]))
      if (values.package !== target.name || values.version !== target.version) throw new Error("Cached package identity differs from the requested identity")
      if (!values.integrity || target.integrity && values.integrity !== target.integrity) throw new Error("Cached integrity differs from the required artifact")
      const schema = Number(values.schemaVersion ?? 1)
      if (![1, 2, 3].includes(schema) || values.format !== undefined && !["baseline", "compact", "trimmed"].includes(values.format)) throw new Error("Unsupported cached index format or schema")
      db.prepare("SELECT id FROM symbols LIMIT 1").get()
      db.prepare("SELECT rowid FROM symbol_search LIMIT 1").get()
      db.prepare("SELECT 1 FROM edges LIMIT 1").get()
      return { cache: "ready" }
    } finally { db.close() }
  } catch (error) { return { cache: "invalid", reason: message(error) } }
}

export async function planSync(options: SyncOptions): Promise<SyncPlan> {
  const plan: SyncPlan = { ready: false, force: options.force ?? false, savedScope: null, projects: [], targets: [], skipped: [], issues: [] }
  const read = projectReader()
  try {
    if (options.workspaces && options.projects?.length) throw new Error("--workspaces and --project cannot be combined")
    if ((options.projects?.length ?? 0) > 1000) throw new Error("Sync selection exceeds 1000 projects")
    const cwd = await realpath(resolve(options.cwd))
    const saved = !options.workspaces && !options.projects?.length ? await readScope(cwd) : null
    plan.savedScope = saved
    const boundary = await projectBoundary(saved?.root ?? cwd, read)
    const candidates = options.workspaces ? await discoverWorkspaces(cwd, read) : options.projects?.length ? options.projects.map(path => resolve(cwd, path)) : saved ? await resolveScopeProjects(saved) : [cwd]
    const projects: string[] = []
    for (const candidate of candidates) {
      const path = await realpath(candidate)
      if (!insideProject(boundary, path)) throw new Error(`Selected project is outside ${boundary}: ${candidate}`)
      if (!(await lstat(path)).isDirectory()) throw new Error(`Selected project must be a directory: ${candidate}`)
      if (!projects.includes(path)) projects.push(path)
    }
    if (options.lockfile && projects.length !== 1) throw new Error("--lockfile requires exactly one selected project")
    const requested = new Set(options.packages ?? [])
    const found = new Set<string>()
    const targets = new Map<string, SyncTarget>()
    const workspaceManifests = new Map<string, Promise<Array<{ name: string; version: string }>>>()
    const localWorkspace = async (root: string, name: string, range: string): Promise<boolean> => {
      let manifests = workspaceManifests.get(root)
      if (!manifests) {
        manifests = discoverWorkspaces(root, read).then(async paths => Promise.all(paths.slice(1).map(async path => JSON.parse((await read(join(path, "package.json")))!))))
        workspaceManifests.set(root, manifests)
      }
      return (await manifests).some(manifest => manifest.name === name && typeof manifest.version === "string" && satisfies(manifest.version, range))
    }
    for (const project of projects.sort()) {
      const selection = { root: project, lockfile: null as string | null }
      plan.projects.push(selection)
      try {
        const text = await read(join(project, "package.json"))
        if (text === undefined) throw new Error(`No package.json found in ${project}`)
        const declared = Object.entries(declaredDependencies(JSON.parse(text))).sort(([a], [b]) => a.localeCompare(b))
        const selected = declared.filter(([alias, spec]) => {
          if (typeof spec !== "string") throw new Error(`Invalid dependency specification for ${alias}`)
          const name = packageName(alias, spec)
          const matches = [...requested].filter(item => item === alias || item === name)
          for (const item of matches) found.add(item)
          return !requested.size || matches.length > 0
        })
        const registry = selected.filter(([alias, spec]) => {
          if (!/^(workspace:|link:|file:|portal:)/.test(spec)) return true
          plan.skipped.push({ project, name: alias, reason: "Local or workspace dependency" })
          return false
        })
        if (!registry.length && !options.lockfile) continue
        const ownerBoundary = await projectBoundary(project, read)
        const lock = await resolveProjectLockfile(project, ownerBoundary, read, options.lockfile ? resolve(cwd, options.lockfile) : undefined)
        if (!lock) throw new Error(`No supported lockfile for ${project}; expected ${lockfileNames.join(", ")}`)
        selection.lockfile = lock.path
        for (const [alias, spec] of registry) {
          if (lock.isLocal(project, alias, spec)) {
            plan.skipped.push({ project, name: alias, reason: "Local or workspace dependency" })
            continue
          }
          const entry = lock.direct(project, alias, spec)
          if (lock.workspaceRanges && await localWorkspace(dirname(lock.path), alias, spec)) {
            plan.skipped.push({ project, name: alias, reason: "Local or workspace dependency" })
            continue
          }
          if (!entry) {
            plan.issues.push(`No exact locked registry identity for ${alias} in ${lock.path}`)
            continue
          }
          const key = `${entry.name}@${entry.version}`
          const source = { project, lockfile: lock.path, alias }
          const prior = targets.get(key)
          if (prior) {
            if (prior.integrity && entry.integrity && prior.integrity !== entry.integrity) plan.issues.push(`Conflicting integrity for ${key}: ${prior.sources[0]!.lockfile} and ${lock.path}`)
            else if (entry.integrity) prior.integrity = entry.integrity
            prior.sources.push(source)
          } else targets.set(key, { name: entry.name, version: entry.version, ...(entry.integrity ? { integrity: entry.integrity } : {}), sources: [source], cache: "missing" })
        }
      } catch (error) { plan.issues.push(message(error)) }
    }
    for (const name of requested) if (!found.has(name)) plan.issues.push(`Unknown requested dependency: ${name}`)
    plan.targets = [...targets.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    for (const target of plan.targets) Object.assign(target, cacheState(target))
  } catch (error) { plan.issues.push(message(error)) }
  plan.issues = [...new Set(plan.issues)]
  plan.ready = plan.issues.length === 0
  return plan
}
