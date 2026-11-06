import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { assertRegistrySpec, assertPackageName, assertExactVersion } from "./identity.js"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  const response = JSON.parse(stdout) as NpmView | NpmView[]
  const value = Array.isArray(response) ? response.length === 1 ? response[0] : undefined : response
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

export type PackedArtifact = {
  id: string; name: string; version: string; filename: string; size: number; unpackedSize: number
  [key: string]: unknown
}

export function parsePackedArtifact(output: unknown, identity: { name: string; version: string }): PackedArtifact {
  assertPackageName(identity.name)
  assertExactVersion(identity.version)
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  const value = Array.isArray(output) ? output.length === 1 ? output[0] : undefined :
    record(output) && Object.keys(output).length === 1 && Object.hasOwn(output, identity.name) ? output[identity.name] : undefined
  const filename = `${identity.name.replace(/^@/, "").replace("/", "-")}-${identity.version}.tgz`
  if (!record(value) || value.id !== `${identity.name}@${identity.version}` || value.name !== identity.name || value.version !== identity.version ||
    value.filename !== filename || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
    typeof value.unpackedSize !== "number" || !Number.isSafeInteger(value.unpackedSize) || value.unpackedSize < 0) {
    throw new Error(`npm pack returned an invalid artifact for ${identity.name}@${identity.version}`)
  }
  return value as PackedArtifact
}

export async function packPackage(identity: PackageIdentity): Promise<PackedPackage> {
  assertPackageName(identity.name)
  assertExactVersion(identity.version)
  const directory = await mkdtemp(join(tmpdir(), "typelatch-"))
  try {
    const { stdout } = await execFileAsync("npm", ["pack", `${identity.name}@${identity.version}`, "--pack-destination", directory, "--ignore-scripts", "--json"], {
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024
    })
    const packed = parsePackedArtifact(JSON.parse(stdout), identity)
    const tarballPath = join(directory, packed.filename)
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
