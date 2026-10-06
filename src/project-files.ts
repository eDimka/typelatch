import { lstat, readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { minimatch } from "minimatch"
import { parseAllDocuments } from "yaml"

export const insideProject = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export type ProjectRead = (path: string) => Promise<string | undefined>

export function projectReader(): ProjectRead {
  const observed = new Map<string, Promise<string | undefined>>()
  let bytes = 0
  return path => {
    let pending = observed.get(path)
    if (!pending) {
      pending = (async () => {
        let info
        try { info = await lstat(path) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
        if (!info.isFile() || await realpath(path) !== path) throw new Error(`Expected a regular project file without symlinks: ${path}`)
        if (info.size > 16 * 1024 * 1024) throw new Error(`Project file exceeds 16 MiB: ${path}`)
        bytes += info.size
        if (bytes > 64 * 1024 * 1024 || observed.size > 20_000) throw new Error("Project file reads exceed sync planning limits")
        return readFile(path, "utf8")
      })()
      observed.set(path, pending)
    }
    return pending
  }
}

export function workspacePatterns(manifest: Record<string, unknown>, yaml?: string): string[] {
  const declared = Array.isArray(manifest.workspaces) ? manifest.workspaces :
    manifest.workspaces && typeof manifest.workspaces === "object" ? (manifest.workspaces as { packages?: unknown }).packages : undefined
  let patterns = declared
  if (yaml !== undefined) {
    const documents = parseAllDocuments(yaml, { uniqueKeys: true })
    if (documents.length !== 1 || documents[0]!.errors.length) throw new Error("Invalid pnpm-workspace.yaml")
    const data = documents[0]!.toJS({ maxAliasCount: 100 })
    patterns = data?.packages ?? []
  }
  if (patterns === undefined) return []
  if (!Array.isArray(patterns) || patterns.some(item => typeof item !== "string")) throw new Error("Workspace packages must be an array of glob strings")
  if (patterns.length > 200) throw new Error("Workspace selection exceeds 200 patterns")
  return patterns.map(pattern => {
    const value = pattern.replace(/^!/, "")
    if (!value || value.length > 1024 || isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error(`Workspace pattern must stay within the project: ${pattern}`)
    return pattern.replace(/^(\!?)(?:\.\/)+/, "$1").replace(/\/$/, "")
  })
}

export function matchesWorkspace(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => !pattern.startsWith("!") && minimatch(path, pattern, { dot: false })) &&
    !patterns.some(pattern => pattern.startsWith("!") && minimatch(path, pattern.slice(1), { dot: false }))
}

export async function projectBoundary(project: string, read: ProjectRead): Promise<string> {
  let directory = resolve(project)
  let workspaceRoot = directory
  for (let depth = 0; depth < 64; depth++) {
    const git = await lstat(join(directory, ".git")).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
    if (git) return directory
    if (directory !== project) {
      const text = await read(join(directory, "package.json"))
      const yaml = await read(join(directory, "pnpm-workspace.yaml"))
      if (text || yaml) {
        const patterns = workspacePatterns(text ? JSON.parse(text) : {}, yaml)
        if (matchesWorkspace(relative(directory, project).split(sep).join("/"), patterns)) workspaceRoot = directory
      }
    }
    if (dirname(directory) === directory) return workspaceRoot
    directory = dirname(directory)
  }
  throw new Error("Project ancestry exceeds 64 directories")
}
