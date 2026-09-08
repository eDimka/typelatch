import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { x } from "tar"

export function extractArchive(file: string, directory: string): void {
  let files = 0, bytes = 0
  x({ file, cwd: directory, sync: true, strict: true, preservePaths: false, noChmod: true, noMtime: true,
    filter: (path, entry) => {
      if (++files > 50_000 || (bytes += entry.size) > 512 * 1024 * 1024) throw new Error("Package archive exceeds extraction limits")
      if (!path.startsWith("package/") || path.includes("\\") || path.split("/").some(part => part === "..") || /[\x00-\x1f]/.test(path)) throw new Error(`Unsafe package archive path: ${path}`)
      // tar's filter types the entry as Stats | ReadEntry and the exported Stats
      // type lacks the guard methods, so probe structurally.
      const probe = entry as { type?: unknown; isFile?: unknown; isDirectory?: unknown }
      const isFile = typeof probe.isFile === "function" ? (probe.isFile as () => boolean)() : probe.type === "File"
      const isDirectory = typeof probe.isDirectory === "function" ? (probe.isDirectory as () => boolean)() : probe.type === "Directory"
      if (!(isFile || isDirectory)) throw new Error("Unsupported archive entry type: not a regular file or directory")
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
