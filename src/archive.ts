import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { x } from "tar"

export function extractArchive(file: string, directory: string): void {
  let files = 0, bytes = 0
  let root: string | undefined
  const destination = join(directory, "package")
  mkdirSync(destination, { recursive: true })
  x({ file, cwd: destination, strip: 1, sync: true, strict: true, preservePaths: false, noChmod: true, noMtime: true,
    filter: (path, entry) => {
      if (++files > 50_000 || (bytes += entry.size) > 512 * 1024 * 1024) throw new Error("Package archive exceeds extraction limits")
      const parts = path.split("/")
      const entryRoot = parts[0]
      if (!entryRoot || entryRoot === "." || entryRoot.includes(":") || path.includes("\\") || parts.some(part => part === "..") || /[\x00-\x1f]/.test(path)) throw new Error(`Unsafe package archive path: ${path}`)
      // tar's filter types the entry as Stats | ReadEntry and the exported Stats
      // type lacks the guard methods, so probe structurally.
      const probe = entry as { type?: unknown; isFile?: unknown; isDirectory?: unknown }
      const isFile = typeof probe.isFile === "function" ? (probe.isFile as () => boolean)() : probe.type === "File"
      const isDirectory = typeof probe.isDirectory === "function" ? (probe.isDirectory as () => boolean)() : probe.type === "Directory"
      if (!(isFile || isDirectory)) throw new Error("Unsupported archive entry type: not a regular file or directory")
      if (!isDirectory && parts.length < 2) throw new Error(`Unsafe package archive path: ${path}`)
      // Older registry artifacts, including DefinitelyTyped, use a named root.
      // Strip that one root while keeping every extracted path inside package.
      if (root !== undefined && root !== entryRoot) throw new Error("Package archive contains multiple roots")
      root = entryRoot
      return true
    }
  })
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw new Error("Expected archive and extraction directory")
    extractArchive(process.argv[2], process.argv[3])
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
