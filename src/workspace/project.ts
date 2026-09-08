import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { readFileSync, realpathSync } from "node:fs"
import type ts from "typescript"

export type Check = { status: "pass" | "fail" | "unknown" | "not-run"; reason: string }
export type Overlay = { file: string; text: string }
export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

// Node caches both module resolution and executed compiler modules. A compiler
// change requires a new process, even if no language service was retained.
const compilerInputs = new Map<string, string | null>()
const compilerInstallations = new Map<string, string | null>()
function diskHash(file: string): string | null {
  try { return sha256(readFileSync(file, "utf8")) } catch { return null }
}
function realPath(file: string): string | null {
  try { return realpathSync(file) } catch { return null }
}
export function compilerRuntimeUnchanged(): boolean {
  for (const [file, hash] of compilerInputs) if (diskHash(file) !== hash) return false
  for (const [file, path] of compilerInstallations) if (realPath(file) !== path) return false
  return true
}

/** A compiler instance; retained navigation instances validate every observed input. */
export class WorkspaceProject {
  readonly ts: typeof ts
  readonly compilerPath: string
  readonly config: string
  readonly root: string
  readonly parsed: ts.ParsedCommandLine
  readonly service: ts.LanguageService
  private readonly inputs = new Map<string, string>()
  private readonly overlays = new Map<string, string>()
  private readonly probes = new Map<string, () => boolean>()
  private readonly evidence = new Map<string, string>()

  constructor(config: string, overlays: Overlay[] = []) {
    this.config = resolve(config)
    this.root = dirname(this.config)
    const require = createRequire(this.config)
    this.compilerPath = require.resolve("typescript")
    this.ts = require(this.compilerPath) as typeof ts
    const visited = new Set<string>()
    const recordCompiler = (module: NodeModule | undefined): void => {
      if (!module || visited.has(module.filename)) return
      visited.add(module.filename)
      compilerInputs.set(module.filename, diskHash(module.filename))
      for (const child of module.children) recordCompiler(child)
    }
    recordCompiler(require.cache[this.compilerPath])
    // Node caches resolution/realpaths; changing an installation must retire the
    // worker, even when require.resolve would still return the old cached path.
    for (let directory = this.root; ; directory = dirname(directory)) {
      const installation = resolve(directory, "node_modules/typescript")
      compilerInstallations.set(installation, realPath(installation))
      compilerInputs.set(resolve(installation, "package.json"), diskHash(resolve(installation, "package.json")))
      this.observe("compilerInstallation", [installation], () => {
        try { return realpathSync(installation) } catch { return null }
      })
      if (dirname(directory) === directory) break
    }
    if (typeof this.ts.createLanguageService !== "function") throw new Error("Project TypeScript does not provide a language service")
    for (const overlay of overlays) this.overlays.set(resolve(this.root, overlay.file), overlay.text)
    this.read(this.compilerPath)
    const configFile = this.ts.readConfigFile(this.config, this.read)
    if (configFile.error) throw new Error(this.format(configFile.error).message)
    this.parsed = this.ts.parseJsonConfigFileContent(configFile.config, {
      ...this.ts.sys, readFile: this.read, readDirectory: this.readDirectory,
      fileExists: file => this.observe("fileExists", [file], () => this.ts.sys.fileExists(file)),
      directoryExists: file => this.observe("directoryExists", [file], () => this.ts.sys.directoryExists(file)),
      getDirectories: file => this.observe("getDirectories", [file], () => this.ts.sys.getDirectories(file)),
      ...(this.ts.sys.realpath ? { realpath: (file: string) => this.observe("realpath", [file], () => this.ts.sys.realpath!(file)) } : {})
    }, this.root, undefined, this.config)
    if (this.parsed.errors.length) throw new Error(this.parsed.errors.map(d => this.format(d).message).join("\n"))
    if (this.parsed.options.noCheck) throw new Error("noCheck disables validation; choose a config with type-checking enabled")
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.parsed.options,
      getScriptFileNames: () => this.parsed.fileNames,
      getProjectReferences: () => this.parsed.projectReferences,
      getScriptVersion: () => "0",
      getScriptSnapshot: file => {
        const text = this.read(file)
        return text === undefined ? undefined : this.ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: options => this.ts.getDefaultLibFilePath(options),
      readFile: this.read,
      fileExists: file => this.overlays.has(resolve(file)) || this.observe("fileExists", [file], () => this.ts.sys.fileExists(file)),
      readDirectory: this.readDirectory,
      directoryExists: file => this.observe("directoryExists", [file], () => this.ts.sys.directoryExists(file)),
      getDirectories: file => this.observe("getDirectories", [file], () => this.ts.sys.getDirectories(file)),
      ...(this.ts.sys.realpath ? { realpath: (file: string) => this.observe("realpath", [file], () => this.ts.sys.realpath!(file)) } : {})
    }
    this.service = this.ts.createLanguageService(host)
  }

  private observe<T>(kind: string, args: unknown[], read: () => T): T {
    const value = read()
    const serialized = JSON.stringify(value)
    this.probes.set(JSON.stringify([kind, args]), () => JSON.stringify(read()) === serialized)
    return value
  }

  private readDirectory: ts.System["readDirectory"] = (...args) =>
    this.observe("readDirectory", args, () => this.ts.sys.readDirectory(...args))

  /** Content checks deliberately avoid mtimes: same-size writes must invalidate. */
  reusable(): boolean {
    if (createRequire(this.config).resolve("typescript") !== this.compilerPath) return false
    for (const [file, hash] of this.inputs) {
      const text = this.overlays.get(file) ?? this.ts.sys.readFile(file)
      if ((text === undefined ? "missing" : sha256(text)) !== hash) return false
    }
    for (const probe of this.probes.values()) if (!probe()) return false
    return true
  }

  beginRequest(): void { this.evidence.clear() }

  /** Per-request evidence must not leak another request's package identity. */
  readEvidence(file: string): string | undefined {
    const path = resolve(file)
    const text = this.overlays.get(path) ?? this.ts.sys.readFile(path)
    this.evidence.set(path, text === undefined ? "missing" : sha256(text))
    return text
  }

  read = (file: string): string | undefined => {
    const path = resolve(file)
    const text = this.overlays.get(path) ?? this.ts.sys.readFile(path)
    this.inputs.set(path, text === undefined ? "missing" : sha256(text))
    return text
  }

  program(): ts.Program {
    const program = this.service.getProgram()
    if (!program) throw new Error("TypeScript could not create a project program")
    return program
  }

  source(file: string): ts.SourceFile {
    const path = resolve(this.root, file)
    const source = this.program().getSourceFile(path)
    if (!source) throw new Error(`File is not included in this project: ${path}`)
    return source
  }

  format(diagnostic: ts.Diagnostic) {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined
    return {
      code: diagnostic.code,
      category: this.ts.DiagnosticCategory[diagnostic.category],
      message: this.ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      file: diagnostic.file?.fileName ?? null,
      line: location ? location.line + 1 : null,
      column: location ? location.character + 1 : null
    }
  }

  typecheck() {
    const diagnostics = this.parsed.projectReferences?.length ? this.solutionDiagnostics() : this.ts.getPreEmitDiagnostics(this.program()).map(d => this.format(d))
    return {
      status: diagnostics.some(d => d.category === "Error") ? "fail" as const : "pass" as const,
      reason: "Project compiler diagnostics, no emit; honors tsconfig including skipLibCheck",
      diagnostics
    }
  }

  private solutionDiagnostics() {
    const T = this.ts
    const diagnostics: ReturnType<WorkspaceProject["format"]>[] = []
    const outputs = new Map<string, string>()
    const directories = new Set<string>()
    const readFile = (file: string) => outputs.get(resolve(file)) ?? this.read(file)
    const system: ts.System = {
      ...T.sys,
      getCurrentDirectory: () => this.root,
      readFile,
      fileExists: file => outputs.has(resolve(file)) || this.overlays.has(resolve(file)) || T.sys.fileExists(file),
      directoryExists: path => directories.has(resolve(path)) || T.sys.directoryExists(path),
      writeFile: (file, text) => {
        outputs.set(resolve(file), text)
        let path = dirname(resolve(file))
        while (!directories.has(path)) { directories.add(path); const parent = dirname(path); if (parent === path) break; path = parent }
      },
      createDirectory: path => { directories.add(resolve(path)) },
      getModifiedTime: file => outputs.has(resolve(file)) || this.overlays.has(resolve(file)) ? new Date() : T.sys.getModifiedTime?.(file),
      setModifiedTime: () => {}, deleteFile: file => { outputs.delete(resolve(file)) },
      write: () => {}
    }
    const host = T.createSolutionBuilderHost(system, undefined, diagnostic => diagnostics.push(this.format(diagnostic)), () => {})
    host.getParsedCommandLine = file => {
      const parsed = T.getParsedCommandLineOfConfigFile(file, undefined, { ...system, onUnRecoverableConfigFileDiagnostic: d => diagnostics.push(this.format(d)) })
      if (parsed?.options.noCheck) throw new Error(`noCheck disables validation: ${file}`)
      return parsed
    }
    T.createSolutionBuilder(host, [this.config], { force: true }).build()
    return diagnostics
  }

  snapshot() {
    const inputs = [...new Map([...this.inputs, ...this.evidence])].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => ({ file, sha256: hash }))
    const overlayFiles = [...this.overlays.keys()].sort()
    return {
      id: sha256(JSON.stringify({ inputs, roots: this.parsed.fileNames, options: this.parsed.options })),
      config: this.config,
      compiler: { version: this.ts.version, path: this.compilerPath },
      scope: "Compiler-read inputs and configuration; not a full runtime filesystem snapshot",
      overlayFiles,
      inputs
    }
  }

  dispose(): void { this.service.dispose() }
}

/** Select the config that owns a file, including a solution's referenced leaves. */
export function openProjectForFile(config: string, file: string, overlays: Overlay[] = []): WorkspaceProject {
  const target = resolve(dirname(resolve(config)), file)
  const seen = new Set<string>()
  const visit = (path: string): WorkspaceProject | null => {
    if (seen.has(path)) return null
    seen.add(path)
    const project = new WorkspaceProject(path, overlays)
    if (project.parsed.fileNames.includes(target)) return project
    const references = project.parsed.projectReferences ?? []
    if (!references.length && project.program().getSourceFile(target)) return project
    project.dispose()
    for (const reference of references) {
      const childConfig = project.ts.resolveProjectReferencePath(reference)
      const child = visit(childConfig)
      if (child) return child
    }
    return null
  }
  const project = visit(resolve(config))
  if (!project) throw new Error(`File is not included in this project: ${target}`)
  return project
}
