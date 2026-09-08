import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { sha256 } from "./project.js"

export const defaultExclusions = [".git", "node_modules", ".apirova", ".mimosa", ".v2c", ".video_agent", "coverage"]
export function runtimeSnapshot(root: string, extraInputs: string[] = [], excluded: string[] = defaultExclusions) {
  const canonicalRoot = realpathSync(root)
  const entries: Array<{ file: string; sha256: string }> = []
  let bytes = 0
  const seen = new Set<string>()
  const exclusions = excluded.map(path => {
    if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path === "." || path === "") throw new Error("Snapshot exclusions must be relative subpaths")
    return path.replaceAll("\\", "/").replace(/\/$/, "")
  })
  const walk = (path: string, base: string, explicit: boolean): void => {
    const rel = relative(base, path).replaceAll("\\", "/")
    if (!explicit && exclusions.some(ex => rel === ex || rel.startsWith(`${ex}/`))) return
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      const target = realpathSync(path)
      entries.push({ file: path, sha256: sha256(readlinkSync(path)) })
      if (seen.has(target)) return
      walk(target, base, explicit)
      return
    }
    if (seen.has(path)) return
    seen.add(path)
    if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort()) walk(join(path, entry), base, explicit)
    } else if (info.isFile()) {
      bytes += info.size
      if (bytes > 512 * 1024 * 1024 || entries.length >= 50_000) throw new Error("Runtime snapshot exceeds 512 MiB or 50,000 files; narrow its explicit scope")
      entries.push({ file: path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })
    } else throw new Error(`Unsupported special file in snapshot: ${path}`)
  }
  walk(canonicalRoot, canonicalRoot, false)
  for (const file of extraInputs) walk(realpathSync(resolve(canonicalRoot, file)), canonicalRoot, true)
  entries.sort((a, b) => a.file.localeCompare(b.file))
  return {
    id: sha256(JSON.stringify(entries)), root: canonicalRoot, bytes, files: entries.length,
    excluded: exclusions, extraInputs,
    scope: "Local workspace files plus explicit runtime inputs; excluded dependencies, remote services and external state are not certified",
    inputs: entries
  }
}
