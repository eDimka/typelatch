import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

type Dependency = { name: string; version: string }

export async function projectDependencies(cwd: string): Promise<Dependency[]> {
  const packageJsonPath = join(cwd, "package.json")
  if (!existsSync(packageJsonPath)) throw new Error(`No package.json found in ${cwd}`)
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const requested = { ...packageJson.dependencies, ...packageJson.devDependencies }
  const lockPath = join(cwd, "package-lock.json")
  if (!existsSync(lockPath)) {
    throw new Error("MVP sync requires package-lock.json so versions are exact")
  }
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    packages?: Record<string, { version?: string }>
    dependencies?: Record<string, { version?: string }>
  }
  const dependencies: Dependency[] = []
  for (const name of Object.keys(requested).sort()) {
    const version = lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version
    if (version) dependencies.push({ name, version })
  }
  return dependencies
}

export async function exactProjectVersion(cwd: string, name: string): Promise<string | null> {
  return (await projectDependencies(cwd)).find((dependency) => dependency.name === name)?.version ?? null
}
