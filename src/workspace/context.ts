import { existsSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type ts from "typescript"
import { openBrainDatabase } from "../database.js"
import { brainPath } from "../paths.js"
import { getSymbol, queryBrain } from "../query.js"
import type { QueryResponse } from "../types.js"
import { WorkspaceProject, compilerRuntimeUnchanged, openProjectForFile, sha256, type Check, type Overlay } from "./project.js"

export type ContextRequest = {
  symbol?: string | undefined
  timeoutMs?: number | undefined
  config: string
  file: string
  /** Zero-based UTF-16 offset, matching the TypeScript language service. */
  position?: number | undefined
  /** Existing import, or a temporary in-memory import probe. */
  importSpecifier?: string | undefined
  question?: string | undefined
  expectedVersion?: string | undefined
  overlays?: Overlay[] | undefined
  limit?: number | undefined
}

function packageIdentity(project: WorkspaceProject, file: string) {
  let directory = dirname(realpathSync(file))
  while (true) {
    const manifest = join(directory, "package.json")
    const text = project.readEvidence(manifest)
    if (text !== undefined) {
      const value: unknown = JSON.parse(text)
      if (value && typeof value === "object" && "name" in value && "version" in value &&
          typeof value.name === "string" && typeof value.version === "string") {
        return { name: value.name, version: value.version, root: directory, manifest, manifestHash: sha256(text) }
      }
      // A nested ESM/CJS package boundary may only contain { type: ... }.
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/** One retained project, exclusively owned by a serial compiler worker. */
export class ContextSession {
  private retained: { key: string; project: WorkspaceProject } | undefined
  private configurations = new Set<string>()

  acquire(config: string, file: string, overlays: Overlay[]): WorkspaceProject {
    if (!compilerRuntimeUnchanged()) throw new Error("APIROVA_RESTART_COMPILER")
    this.configurations.add(resolve(config))
    if (this.configurations.size > 16) throw new Error("APIROVA_RESTART_COMPILER")
    const key = JSON.stringify([resolve(config), overlays])
    if (this.retained?.key === key && this.retained.project.parsed.fileNames.includes(file)) {
      if (!this.retained.project.reusable()) throw new Error("APIROVA_RESTART_COMPILER")
      this.retained.project.beginRequest()
      return this.retained.project
    }
    this.dispose()
    const project = openProjectForFile(config, file, overlays)
    // Solution selection may depend on other configs. Rebuild conservatively.
    if (project.config === resolve(config) && !project.parsed.projectReferences?.length) this.retained = { key, project }
    return project
  }

  release(project: WorkspaceProject): void { if (project !== this.retained?.project) project.dispose() }
  discard(project: WorkspaceProject): void {
    if (project === this.retained?.project) this.retained = undefined
    project.dispose()
  }
  dispose(): void { this.retained?.project.dispose(); this.retained = undefined }
}

export function workspaceContext(request: ContextRequest, session?: ContextSession) {
  const started = performance.now()
  const originalRoot = dirname(resolve(request.config))
  const file = resolve(originalRoot, request.file)
  const overlays = (request.overlays ?? []).map(o => ({ file: resolve(originalRoot, o.file), text: o.text }))
  let project = session ? session.acquire(request.config, file, overlays) : openProjectForFile(request.config, file, overlays)
  let syntheticImport = false
  try {
    let source = project.source(file)
    const originalSourceHash = sha256(source.text)
    if (request.importSpecifier && !findImport(project.ts, source, request.importSpecifier)) {
      const file = source.fileName
      const text = `${source.text}\nimport * as __apirova_probe from ${JSON.stringify(request.importSpecifier)};\n`
      const config = project.config
      if (session) session.discard(project)
      else project.dispose()
      project = new WorkspaceProject(config, [...overlays.filter(o => resolve(dirname(config), o.file) !== file), { file, text }])
      source = project.source(file)
      syntheticImport = true
    }
    const T = project.ts
    let resolved: Check = { status: "not-run", reason: "No symbol position or import requested" }
    let hover: { text: string; documentation: string } | null = null
    let definitions: Array<{ file: string; start: number; length: number; name: string }> = []
    let references: Array<{ file: string; start: number; length: number }> = []
    if (request.position !== undefined) {
      if (!Number.isInteger(request.position) || request.position < 0 || request.position >= source.text.length) {
        throw new Error("position must be a zero-based UTF-16 offset within the file")
      }
      const info = project.service.getQuickInfoAtPosition(source.fileName, request.position)
      hover = info ? { text: T.displayPartsToString(info.displayParts).slice(0, 16000), documentation: T.displayPartsToString(info.documentation).slice(0, 12000) } : null
      definitions = (project.service.getDefinitionAtPosition(source.fileName, request.position) ?? []).slice(0, 20).map(d => ({
        file: d.fileName, start: d.textSpan.start, length: d.textSpan.length, name: d.name
      }))
      references = (project.service.getReferencesAtPosition(source.fileName, request.position) ?? []).slice(0, 50).map(r => ({
        file: r.fileName, start: r.textSpan.start, length: r.textSpan.length
      }))
      resolved = { status: definitions.length ? "pass" : "unknown", reason: "Live symbol navigation only; not proof that this usage type-checks" }
    }
    let dependency: ReturnType<typeof packageIdentity> = null
    let declaration: string | null = null
    let versionMatch: Check = { status: "not-run", reason: "No expected version supplied" }
    let literal: ts.StringLiteralLike | undefined
    if (request.importSpecifier) {
      literal = findImport(T, source, request.importSpecifier)
      if (!literal) {
        resolved = { status: "unknown", reason: "Import is absent from this file; no resolution mode was guessed" }
      } else {
        const symbol = project.program().getTypeChecker().getSymbolAtLocation(literal)
        declaration = symbol?.declarations?.find(d => T.isSourceFile(d))?.getSourceFile().fileName ?? null
        if (declaration && existsSync(declaration)) dependency = packageIdentity(project, declaration)
        resolved = { status: declaration ? "pass" : "unknown", reason: declaration ? "Import resolved by the project compiler" : "Import has no resolved source declaration" }
      }
      if (request.expectedVersion !== undefined) versionMatch = {
        status: dependency ? dependency.version === request.expectedVersion ? "pass" : "fail" : "unknown",
        reason: dependency ? `Resolved ${dependency.name}@${dependency.version}; expected ${request.expectedVersion}` : "No package identity resolved"
      }
    }
    let brain: QueryResponse | null = null
    let retrieved: Check = { status: "not-run", reason: "No discovery question supplied" }
    let brainProvenance: { file: string; metadataSha256: string; integrity: string } | null = null
    if (request.question) {
      retrieved = { status: "unknown", reason: "Discovery requires an existing import resolving to a package" }
      if (dependency && versionMatch.status !== "fail") {
        const file = brainPath(dependency.name, dependency.version)
        if (!existsSync(file)) retrieved = { status: "unknown", reason: `No brain installed for ${dependency.name}@${dependency.version}` }
        else {
          const db = openBrainDatabase(file)
          try {
            const metadata = Object.fromEntries((db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>).map(r => [r.key, r.value]))
            if (metadata.package !== dependency.name || metadata.version !== dependency.version || !metadata.integrity) {
              retrieved = { status: "fail", reason: "Brain metadata does not match the resolved package identity" }
            } else {
              brain = queryBrain(dependency.name, request.question, { version: dependency.version, limit: request.limit ?? 5, recordUsage: false })
              brainProvenance = { file, metadataSha256: sha256(JSON.stringify(metadata)), integrity: metadata.integrity }
              retrieved = { status: brain.results.length ? "pass" : "unknown", reason: "Exact-version discovery only; individual candidates have not been resolved in this file" }
            }
          } finally { db.close() }
        }
      } else if (versionMatch.status === "fail") retrieved = { status: "not-run", reason: "Version mismatch blocks brain discovery" }
    }
    const api = literal && request.symbol ? resolveExport(project, literal, request.symbol) : null
    const candidates = brain?.results.map(result => ({
      symbol: result.symbol,
      // Index module paths are not JavaScript namespaces. Probe the candidate's
      // local name against the actual imported module, without claiming that
      // a same-name workspace export is the identical registry artifact.
      workspaceExport: literal ? resolveExport(project, literal,
        result.symbol.startsWith(`${result.module}.`) ? result.symbol.slice(result.module.length + 1) : result.symbol, true) : null,
      artifactEquivalent: false
    })) ?? []
    const navigation = (() => {
      const empty = (status: Check["status"], reason: string) => ({ status, reason, exportName: null as string | null, brain: null as QueryResponse | null, artifactEquivalent: false })
      if (request.position === undefined || !literal) return empty("not-run", "Navigation requires a cursor and resolved import")
      if (!dependency || versionMatch.status === "fail") return empty("not-run", "Missing dependency identity or version mismatch blocks navigation")
      const checker = project.program().getTypeChecker()
      let at: ts.Node = source
      const visit = (node: ts.Node): void => {
        if (node.getStart() <= request.position! && request.position! < node.getEnd()) { at = node; T.forEachChild(node, visit) }
      }
      visit(source)
      const unwrap = (symbol: ts.Symbol) => symbol.flags & T.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      const cursor = checker.getSymbolAtLocation(at)
      const module = checker.getSymbolAtLocation(literal)
      if (!cursor || !module) return empty("unknown", "Cursor has no module export identity")
      const target = unwrap(cursor)
      const exports = checker.getExportsOfModule(module).filter(exported => unwrap(exported) === target)
      if (exports.length !== 1) return empty("unknown", "Cursor does not uniquely identify a direct module export")
      const exported = exports[0]!
      const path = brainPath(dependency.name, dependency.version)
      if (!existsSync(path)) return empty("unknown", "No exact-version brain installed")
      const db = openBrainDatabase(path)
      try {
        const metadata = Object.fromEntries((db.prepare("SELECT key, value FROM metadata").all() as Array<{key: string; value: string}>).map(r => [r.key, r.value]))
        if (metadata.package !== dependency.name || metadata.version !== dependency.version || !metadata.integrity) return empty("fail", "Brain metadata does not match resolved dependency")
      } finally { db.close() }
      const declarationName = target.declarations?.flatMap(d => "name" in d && d.name && T.isIdentifier(d.name as ts.Node) ? [(d.name as ts.Identifier).text] : [])[0]
      const lookup = exported.name === "default" ? declarationName ?? (target.name !== "default" ? target.name : "default") : exported.name
      let result = getSymbol(dependency.name, lookup, { version: dependency.version, recordUsage: false, limit: 20 })
      if (!result.results.length && exported.name === "default") result = getSymbol(dependency.name, "default", { version: dependency.version, recordUsage: false, limit: 20 })
      // Same-name export corroboration only, never registry/workspace equivalence.
      result.results = result.results.filter(candidate => {
        const localName = candidate.symbol.startsWith(`${candidate.module}.`) ? candidate.symbol.slice(candidate.module.length + 1) : candidate.symbol
        const probe = resolveExport(project, literal!, localName, true)
        return probe?.declarations.some(d => target.declarations?.some(t => t.getSourceFile().fileName === d.file && t.getStart() === d.start))
      })
      return { status: result.results.length ? "pass" as const : "unknown" as const,
        reason: "Live cursor export used for exact Brain lookup; separate from question retrieval and artifact equivalence",
        exportName: exported.name, brain: result, artifactEquivalent: false }
    })()
    const snapshot = project.snapshot()
    const { inputs, ...snapshotSummary } = snapshot
    return {
      api, candidates, navigation, syntheticImport, originalSourceHash,
      language: "typescript" as const,
      route: request.position !== undefined ? "language-service-first" : "brain-discovery",
      file, hover, definitions, references, declaration, dependency, brain, brainProvenance,
      checks: {
        retrieved, resolved, versionMatch,
        artifactMatch: { status: "unknown", reason: "Installed package contents have not been compared with the registry artifact" } satisfies Check,
        typechecked: { status: "not-run", reason: "Use workspace validation for project diagnostics" } satisfies Check,
        tested: { status: "not-run", reason: "No test command executed" } satisfies Check
      },
      snapshot: { ...snapshotSummary, inputCount: inputs.length },
      latencyMs: performance.now() - started
    }
  } finally { if (session) session.release(project); else project.dispose() }
}

function findImport(T: typeof ts, source: ts.SourceFile, specifier: string): ts.StringLiteralLike | undefined {
  let found: ts.StringLiteralLike | undefined
  const visit = (node: ts.Node): void => {
    if ((T.isImportDeclaration(node) || T.isExportDeclaration(node)) && node.moduleSpecifier &&
        T.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === specifier) found = node.moduleSpecifier
    if (T.isImportEqualsDeclaration(node) && T.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression &&
        T.isStringLiteralLike(node.moduleReference.expression) && node.moduleReference.expression.text === specifier) found = node.moduleReference.expression
    if (T.isCallExpression(node) && (node.expression.kind === T.SyntaxKind.ImportKeyword || (T.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0]
      if (argument && T.isStringLiteralLike(argument) && argument.text === specifier) found = argument
    }
    T.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function resolveExport(project: WorkspaceProject, literal: ts.StringLiteralLike, name: string, allowDefaultDeclarationName = false) {
  const checker = project.program().getTypeChecker()
  const T = project.ts
  let symbol = checker.getSymbolAtLocation(literal)
  for (const part of name.split(".")) {
    if (!symbol) return null
    if (symbol.flags & T.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    const location = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? literal
    const exports = checker.getExportsOfModule(symbol)
    const defaultExport = allowDefaultDeclarationName && name === part ? exports.find(s => s.name === "default") : undefined
    const defaultTarget = defaultExport && (defaultExport.flags & T.SymbolFlags.Alias) ? checker.getAliasedSymbol(defaultExport) : defaultExport
    const namedDefault = defaultTarget && (defaultTarget.name === part || defaultTarget.declarations?.some(d =>
      "name" in d && d.name && T.isIdentifier(d.name as ts.Node) && (d.name as ts.Identifier).text === part)) ? defaultExport : undefined
    symbol = exports.find(s => s.name === part) ?? namedDefault
      ?? checker.getPropertyOfType(checker.getTypeOfSymbolAtLocation(symbol, location), part)
  }
  if (!symbol) return null
  if (symbol.flags & T.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
  const location = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? literal
  const type = symbol.flags & (T.SymbolFlags.Interface | T.SymbolFlags.TypeAlias)
    ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeOfSymbolAtLocation(symbol, location)
  return {
    name, type: checker.typeToString(type, location, T.TypeFormatFlags.NoTruncation).slice(0, 16000),
    documentation: T.displayPartsToString(symbol.getDocumentationComment(checker)).slice(0, 12000),
    signatures: type.getCallSignatures().slice(0, 10).map(signature => checker.signatureToString(signature).slice(0, 8000)),
    declarations: (symbol.declarations ?? []).slice(0, 10).map(d => ({ file: d.getSourceFile().fileName, start: d.getStart(), length: d.getWidth() })),
    status: "resolved" as const,
    reason: "This named export exists in the workspace; usage compatibility and brain artifact equivalence are separate checks"
  }
}
