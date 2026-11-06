import { createRequire } from "node:module"
import { join } from "node:path"
import { declaredDependencies } from "./lockfiles.js"
import type { ProjectRead } from "./project-files.js"

const require = createRequire(import.meta.url)
export const manifestNames = ["package.json", "deno.json", "deno.jsonc"] as const
type Data = Record<string, any>
export type ProjectManifest = {
  path: string; data: Data; dependencies: Record<string, string>; npmImports: Set<string>
  denoImports: Record<string, string>; deno: boolean; issues: string[]; lock?: unknown
}
const object = (value: unknown): value is Data => value !== null && typeof value === "object" && !Array.isArray(value)

function parse(path: string, text: string, comments = false): Data {
  let data: unknown
  if (comments) {
    const ts = require("typescript") as typeof import("typescript")
    const parsed = ts.parseConfigFileTextToJson(path, text)
    if (parsed.error) throw new Error(`Invalid project manifest: ${path}`)
    data = parsed.config
  } else {
    try { data = JSON.parse(text) } catch { throw new Error(`Invalid project manifest: ${path}`) }
  }
  if (!object(data)) throw new Error(`Invalid project manifest: ${path}`)
  return data
}

export async function readProjectManifest(project: string, read: ProjectRead): Promise<ProjectManifest | undefined> {
  const packageText = await read(join(project, "package.json"))
  const denoJson = await read(join(project, "deno.json"))
  const denoName = denoJson !== undefined ? "deno.json" : "deno.jsonc"
  const denoText = denoJson ?? await read(join(project, "deno.jsonc"))
  if (packageText === undefined && denoText === undefined) return undefined
  const packageData = packageText === undefined ? {} : parse(join(project, "package.json"), packageText)
  const denoData = denoText === undefined ? undefined : parse(join(project, denoName), denoText, true)
  const path = join(project, denoData ? denoName : "package.json")
  const data = { ...packageData }
  const dependencies = declaredDependencies(packageData)
  const npmImports = new Set<string>()
  const denoImports: Record<string, string> = {}
  const issues: string[] = []
  if (denoData) {
    if (packageText === undefined || ["imports", "workspace", "lock"].some(field => denoData[field] !== undefined)) data.packageManager ??= "deno"
    data.name ??= denoData.name
    data.version ??= denoData.version
    if (denoData.workspace !== undefined) {
      const members = object(denoData.workspace) ? denoData.workspace.members : denoData.workspace
      const nodeMembers = Array.isArray(data.workspaces) ? data.workspaces : data.workspaces?.packages ?? []
      if (!Array.isArray(members) || !Array.isArray(nodeMembers)) throw new Error(`Invalid Deno workspace members: ${path}`)
      data.workspaces = [...nodeMembers, ...members]
    }
    for (const field of ["importMap", "scopes", "links", "vendor"] as const) {
      if (denoData[field] !== undefined && denoData[field] !== false) issues.push(`Unsupported Deno ${field}: ${path}`)
    }
    if (denoData.lock === false) issues.push(`Deno lockfile is disabled: ${path}`)
    else if (denoData.lock !== undefined && denoData.lock !== true && denoData.lock !== "deno.lock" &&
      !(object(denoData.lock) && Object.keys(denoData.lock).every(key => ["path", "frozen"].includes(key)) && (denoData.lock.path === undefined || denoData.lock.path === "deno.lock"))) {
      issues.push(`Unsupported Deno lockfile path or configuration: ${path}`)
    }
    if (denoData.imports !== undefined && !object(denoData.imports)) issues.push(`Invalid Deno imports: ${path}`)
    for (const [alias, spec] of Object.entries(object(denoData.imports) ? denoData.imports : {})) {
      if (typeof spec !== "string" || !/^(?:npm:|node:|\.\.?\/)/.test(spec)) {
        issues.push(`Unsupported Deno import ${alias}: ${path}`)
        continue
      }
      const normalized = spec.startsWith("npm:") ? spec : spec.startsWith("node:") ? `link:${spec}` : `file:${spec}`
      if (dependencies[alias] !== undefined && dependencies[alias] !== normalized) {
        issues.push(`Conflicting package.json and Deno import ${alias}: ${path}`)
        delete dependencies[alias]
        continue
      }
      dependencies[alias] = normalized
      denoImports[alias] = normalized
      if (spec.startsWith("npm:")) npmImports.add(alias)
    }
  }
  return { path, data, dependencies, npmImports, denoImports, deno: denoData !== undefined, issues, ...(denoData?.lock !== undefined ? { lock: denoData.lock } : {}) }
}
