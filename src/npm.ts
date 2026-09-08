import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assertRegistrySpec, assertPackageName, assertExactVersion } from "./identity.js"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import type { PackageIdentity } from "./types.js"

const execFileAsync = promisify(execFile)

type NpmView = {
  name: string
  version: string
  "dist.integrity": string
  "dist.tarball": string
}

export async function resolvePackage(spec: string): Promise<PackageIdentity> {
  assertRegistrySpec(spec)
  const { stdout } = await execFileAsync("npm", ["view", spec, "name", "version", "dist.integrity", "dist.tarball", "--json"], {
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024
  })
  const value = JSON.parse(stdout) as NpmView
  if (Array.isArray(value) || !value || typeof value.name !== "string" || typeof value.version !== "string" || typeof value["dist.integrity"] !== "string" || typeof value["dist.tarball"] !== "string") throw new Error("Registry did not resolve one exact artifact; specify an exact version")
  assertPackageName(value.name)
  assertExactVersion(value.version)
  return {
    name: value.name,
    version: value.version,
    integrity: value["dist.integrity"],
    tarballUrl: value["dist.tarball"]
  }
}

export type PackedPackage = {
  directory: string
  packageRoot: string
  tarballPath: string
  packedBytes: number
  unpackedBytes: number
  cleanup: () => Promise<void>
}

export async function packPackage(identity: PackageIdentity): Promise<PackedPackage> {
  assertPackageName(identity.name)
  assertExactVersion(identity.version)
  const directory = await mkdtemp(join(tmpdir(), "apirova-"))
  try {
    const { stdout } = await execFileAsync("npm", ["pack", `${identity.name}@${identity.version}`, "--pack-destination", directory, "--ignore-scripts", "--json"], {
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024
    })
    const packed = (JSON.parse(stdout) as Array<{ filename: string; size: number; unpackedSize: number }>)[0]
    if (!packed) throw new Error(`npm pack returned no artifact for ${identity.name}@${identity.version}`)
    const tarballPath = join(directory, basename(packed.filename))
    if ((await stat(tarballPath)).size > 128 * 1024 * 1024) throw new Error("Package archive exceeds 128 MiB download limit")
    await verifyIntegrity(tarballPath, identity.integrity)
    const built = fileURLToPath(new URL("./archive.js", import.meta.url))
    const source = fileURLToPath(new URL("./archive.ts", import.meta.url))
    const args = existsSync(built) ? [built] : ["--import", import.meta.resolve("tsx"), source]
    await execFileAsync(process.execPath, ["--max-old-space-size=512", ...args, tarballPath, directory], { timeout: 60000, maxBuffer: 1024 * 1024 })
    return {
      directory,
      packageRoot: join(directory, "package"),
      tarballPath,
      packedBytes: packed.size,
      unpackedBytes: packed.unpackedSize,
      cleanup: () => rm(directory, { recursive: true, force: true })
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

export async function verifyIntegrity(path: string, integrity: string): Promise<void> {
  const allowed = ["sha512", "sha384", "sha256"]
  const candidates = integrity.split(/\s+/).map(token => token.match(/^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/)).filter(match => match !== null)
  const strongest = allowed.find(algorithm => candidates.some(match => match[1] === algorithm))
  if (!strongest) throw new Error("Unsupported npm integrity value; require SHA-256 or stronger SRI")
  const actual = createHash(strongest).update(await readFile(path)).digest("base64")
  if (!candidates.some(match => match[1] === strongest && match[2] === actual)) throw new Error(`Integrity mismatch for ${path}`)
}
