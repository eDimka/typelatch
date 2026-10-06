import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import Database from "better-sqlite3"
import ts from "typescript"
import { createBrainDatabase } from "./database.js"
import { packPackage, resolvePackage } from "./npm.js"
import { brainPath } from "./paths.js"
import type { BrainFormat, BrainMetadata, EdgeRecord, PackageIdentity, SymbolRecord } from "./types.js"

export const GENERATOR_VERSION = "typelatch-indexer/0.2.1"
const SCHEMA_VERSIONS: Record<BrainFormat, number> = { baseline: 1, compact: 2, trimmed: 3 }
const EDGE_TYPE_IDS: Record<EdgeRecord["type"], number> = {
  accepts: 1,
  returns: 2,
  references: 3,
  delegates_to: 4,
  re_exports: 5
}

export type BuildOptions = {
  output?: string
  format?: BrainFormat
  onProgress?: (phase: string) => void
  expectedIdentity?: { name: string; version: string; integrity?: string }
}

export async function buildBrain(spec: string, options: BuildOptions = {}): Promise<{ path: string; metadata: BrainMetadata }> {
  options.onProgress?.(`Resolving ${spec} from npm registry`)
  const identity = await resolvePackage(spec)
  const expected = options.expectedIdentity
  if (expected && (identity.name !== expected.name || identity.version !== expected.version || (expected.integrity && identity.integrity !== expected.integrity))) {
    throw new Error("Registry artifact does not match the planned lockfile identity")
  }
  options.onProgress?.(`Downloading and verifying ${identity.name}@${identity.version}`)
  const packed = await packPackage(identity)
  const output = options.output ?? brainPath(identity.name, identity.version)
  const format = options.format ?? "trimmed"
  const temporaryOutput = `${output}.building-${randomUUID()}`
  const generatedAt = new Date().toISOString()

  try {
    options.onProgress?.("Reading package exports and TypeScript sources")
    const packageJson = JSON.parse(await readFile(join(packed.packageRoot, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>
    }
    const publicModules = exportedModules(packageJson.exports, identity.name)
    const discovered = await discoverSources(packed.packageRoot)
    const sourceRoot = discovered.root
    const files = discovered.files
    options.onProgress?.(`Selected ${files.length} ${discovered.kind} files`)
    const symbols: SymbolRecord[] = []
    const edges: EdgeRecord[] = []

    for (const [index, file] of files.entries()) {
      if (index > 0 && index % 75 === 0) options.onProgress?.(`Parsing sources (${index}/${files.length})`)
      const analyzed = await analyzeFile(file, sourceRoot, packed.packageRoot, publicModules, identity.name, discovered.kind)
      symbols.push(...analyzed.symbols)
      edges.push(...analyzed.edges)
    }

    const indexedSymbols = mergeSymbols(symbols)
    enrichReExports(indexedSymbols, edges)
    const readmeName = (await readdir(packed.packageRoot)).sort().find((name) => /^readme(?:\.md|\.markdown)?$/i.test(name))
    if (readmeName) {
      const readme = await readFile(join(packed.packageRoot, readmeName), "utf8")
      enrichFromReadme(indexedSymbols, readme, readmeName)
    }

    options.onProgress?.(`Writing ${indexedSymbols.length.toLocaleString()} symbols and ${edges.length.toLocaleString()} relationships`)
    await mkdir(dirname(output), { recursive: true })
    await rm(temporaryOutput, { force: true })
    const db = createBrainDatabase(temporaryOutput, format)
    try {
      if (format === "baseline") writeBaseline(db, indexedSymbols, edges)
      else if (format === "trimmed") writeTrimmed(db, indexedSymbols, edges)
      else writeCompact(db, indexedSymbols, edges)
      const uniqueEdges = (db.prepare("SELECT count(*) AS count FROM edges").get() as { count: number }).count
      const metadataWithoutBytes = makeMetadata(identity, packed.unpackedBytes, files.length, indexedSymbols, uniqueEdges, format, generatedAt)
      const putMetadata = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
      for (const [key, value] of Object.entries(metadataWithoutBytes)) putMetadata.run(key, String(value))
      db.pragma("wal_checkpoint(TRUNCATE)")
      db.exec("VACUUM")
      db.pragma("journal_mode = DELETE")
    } finally {
      db.close()
    }
    const brainBytes = (await stat(temporaryOutput)).size
    const finalDb = new Database(temporaryOutput)
    try {
      finalDb.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('brainBytes', ?)").run(String(brainBytes))
      finalDb.pragma("journal_mode = DELETE")
    } finally { finalDb.close() }
    await rename(temporaryOutput, output)
    const metadata = {
      ...makeMetadata(identity, packed.unpackedBytes, files.length, indexedSymbols, uniqueEdgeCount(edges), format, generatedAt),
      brainBytes: (await stat(output)).size
    }
    options.onProgress?.("Brain ready")
    return { path: output, metadata }
  } finally {
    await rm(temporaryOutput, { force: true })
    await packed.cleanup()
  }
}

function makeMetadata(
  identity: PackageIdentity,
  sourceBytes: number,
  files: number,
  symbols: SymbolRecord[],
  relationships: number,
  format: BrainFormat,
  generatedAt = new Date().toISOString()
): BrainMetadata {
  return {
    schemaVersion: SCHEMA_VERSIONS[format],
    format,
    package: identity.name,
    version: identity.version,
    integrity: identity.integrity,
    generatedAt,
    generator: GENERATOR_VERSION,
    sourceBytes,
    brainBytes: 0,
    files,
    symbols: symbols.length,
    publicSymbols: symbols.filter((symbol) => symbol.isPublic).length,
    relationships,
    examples: symbols.reduce((total, symbol) => total + symbol.exampleCount, 0),
    deprecatedSymbols: symbols.filter((symbol) => symbol.isDeprecated).length,
    internalSymbols: symbols.filter((symbol) => symbol.isInternal).length
  }
}

function writeBaseline(db: Database.Database, symbols: SymbolRecord[], edges: EdgeRecord[]): void {
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (
      qualified_name, name, kind, module, signature, docs, source_path,
      line_start, line_end, source, is_public, is_deprecated, is_internal,
      category, example_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSearch = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges (from_symbol, to_symbol, type, evidence) VALUES (?, ?, ?, ?)"
  )
  db.transaction(() => {
    for (const symbol of symbols) {
      const inserted = insertSymbol.run(
        symbol.qualifiedName,
        symbol.name,
        symbol.kind,
        symbol.module,
        symbol.signature,
        symbol.docs,
        symbol.sourcePath,
        symbol.lineStart,
        symbol.lineEnd,
        symbol.source,
        Number(symbol.isPublic),
        Number(symbol.isDeprecated),
        Number(symbol.isInternal),
        symbol.category,
        symbol.exampleCount
      )
      insertSearchRow(insertSearch, inserted.lastInsertRowid, symbol)
    }
    for (const edge of edges) insertEdge.run(edge.fromQualifiedName, edge.toQualifiedName, edge.type, edge.evidence)
  })()
}

function writeCompact(db: Database.Database, symbols: SymbolRecord[], edges: EdgeRecord[]): void {
  const insertNode = db.prepare("INSERT INTO nodes (qualified_name) VALUES (?)")
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (
      id, qualified_name, name, kind, module, signature, docs, source_path, line_start, line_end,
      source, is_public, is_deprecated, is_internal, category, example_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSearch = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
  const insertEdge = db.prepare(
    "INSERT OR IGNORE INTO edges (from_id, type, to_id, evidence) VALUES (?, ?, ?, ?)"
  )
  const nodeIds = new Map<string, number>()
  const names = new Set<string>()
  for (const symbol of symbols) names.add(symbol.qualifiedName)
  for (const edge of edges) {
    names.add(edge.fromQualifiedName)
    names.add(edge.toQualifiedName)
  }
  db.transaction(() => {
    for (const name of [...names].sort()) {
      const inserted = insertNode.run(name)
      nodeIds.set(name, Number(inserted.lastInsertRowid))
    }
    for (const symbol of symbols) {
      const id = requiredNodeId(nodeIds, symbol.qualifiedName)
      insertSymbol.run(
        id,
        symbol.qualifiedName,
        symbol.name,
        symbol.kind,
        symbol.module,
        symbol.signature,
        symbol.docs,
        symbol.sourcePath,
        symbol.lineStart,
        symbol.lineEnd,
        symbol.source,
        Number(symbol.isPublic),
        Number(symbol.isDeprecated),
        Number(symbol.isInternal),
        symbol.category,
        symbol.exampleCount
      )
      insertSearchRow(insertSearch, id, symbol)
    }
    for (const edge of edges) {
      insertEdge.run(
        requiredNodeId(nodeIds, edge.fromQualifiedName),
        EDGE_TYPE_IDS[edge.type],
        requiredNodeId(nodeIds, edge.toQualifiedName),
        edge.evidence
      )
    }
  })()
}

function writeTrimmed(db: Database.Database, symbols: SymbolRecord[], edges: EdgeRecord[]): void {
  const insertNode = db.prepare("INSERT INTO nodes (qualified_name) VALUES (?)")
  const insertSymbol = db.prepare(`
    INSERT INTO symbols (
      id, name, kind, module, signature, docs, source_path, line_start, line_end,
      is_public, is_deprecated, is_internal, category, example_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertSearch = db.prepare("INSERT INTO symbol_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)")
  const insertEdge = db.prepare("INSERT OR IGNORE INTO edges (from_id, type, to_id) VALUES (?, ?, ?)")
  const nodeIds = new Map<string, number>()
  const names = new Set<string>()
  for (const symbol of symbols) names.add(symbol.qualifiedName)
  for (const edge of edges) {
    names.add(edge.fromQualifiedName)
    names.add(edge.toQualifiedName)
  }
  db.transaction(() => {
    for (const name of [...names].sort()) {
      const inserted = insertNode.run(name)
      nodeIds.set(name, Number(inserted.lastInsertRowid))
    }
    for (const symbol of symbols) {
      const id = requiredNodeId(nodeIds, symbol.qualifiedName)
      insertSymbol.run(
        id,
        symbol.name,
        symbol.kind,
        symbol.module,
        symbol.signature,
        symbol.docs,
        symbol.sourcePath,
        symbol.lineStart,
        symbol.lineEnd,
        Number(symbol.isPublic),
        Number(symbol.isDeprecated),
        Number(symbol.isInternal),
        symbol.category,
        symbol.exampleCount
      )
      insertSearchRow(insertSearch, id, symbol)
    }
    for (const edge of edges) {
      insertEdge.run(
        requiredNodeId(nodeIds, edge.fromQualifiedName),
        EDGE_TYPE_IDS[edge.type],
        requiredNodeId(nodeIds, edge.toQualifiedName)
      )
    }
  })()
}

function insertSearchRow(statement: Database.Statement, rowId: number | bigint, symbol: SymbolRecord): void {
  statement.run(
    rowId,
    `${symbol.qualifiedName} ${splitIdentifier(symbol.name)}`,
    `${symbol.docs}\n${symbol.signature}`,
    `${symbol.category ?? ""} ${symbol.kind} ${symbol.isPublic ? "public" : "internal"}`
  )
}

function requiredNodeId(nodeIds: Map<string, number>, name: string): number {
  const id = nodeIds.get(name)
  if (id === undefined) throw new Error(`Missing interned node id for ${name}`)
  return id
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  }))
  return nested.flat()
}

function exportedModules(exportsMap: Record<string, unknown> | undefined, packageName: string): Set<string> {
  const modules = new Set<string>()
  if (!exportsMap) return modules
  modules.add(packageModuleName(packageName))
  modules.add("index")
  for (const key of Object.keys(exportsMap)) {
    if (key === ".") modules.add(packageModuleName(packageName))
    else if (key.startsWith("./")) modules.add(key.slice(2))
  }
  return modules
}

async function discoverSources(packageRoot: string): Promise<{ root: string; files: string[]; kind: "source" | "declaration" }> {
  const sourceRoot = join(packageRoot, "src")
  const sourceFiles = await pathExists(sourceRoot)
    ? (await walk(sourceRoot)).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.d\.(ts|mts|cts)$/.test(path))
    : []
  if (sourceFiles.length > 0) return { root: sourceRoot, files: sourceFiles, kind: "source" }
  const declarations = (await walk(packageRoot)).filter((path) => /\.d\.(ts|mts|cts)$/.test(path))
  const preferred = new Map<string, string>()
  for (const path of declarations.sort(declarationPreference)) {
    const canonical = path.replace(/\.d\.(mts|cts)$/, ".d.ts")
    if (!preferred.has(canonical)) preferred.set(canonical, path)
  }
  if (preferred.size === 0) throw new Error(`Package contains neither TypeScript source nor declaration files: ${packageRoot}`)
  return { root: packageRoot, files: [...preferred.values()], kind: "declaration" }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function declarationPreference(left: string, right: string): number {
  const score = (path: string): number => path.endsWith(".d.ts") ? 0 : path.endsWith(".d.mts") ? 1 : 2
  return score(left) - score(right) || left.localeCompare(right)
}

export async function analyzeFile(
  file: string,
  sourceRoot: string,
  packageRoot: string,
  publicModules: Set<string>,
  packageName: string,
  mode: "source" | "declaration"
): Promise<{
  symbols: SymbolRecord[]
  edges: EdgeRecord[]
}> {
  const text = await readFile(file, "utf8")
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const relativePath = relative(packageRoot, file).split(sep).join("/")
  const module = logicalModule(file, sourceRoot, packageRoot, packageName)
  const isModulePublic = moduleIsPublic(module, publicModules, mode)
  const resolve = (specifier: string): string | null => resolveFileModule(file, specifier, sourceRoot, packageRoot, packageName, mode)
  const imports = collectImports(sourceFile, resolve)
  const localExports = collectLocalExports(sourceFile)
  const localDeclarations = new Map<string, NamedDeclaration[]>()
  for (const statement of sourceFile.statements) {
    for (const declaration of declarationsFrom(statement)) {
      const name = declarationName(declaration)
      if (name) localDeclarations.set(name, [...(localDeclarations.get(name) ?? []), declaration])
    }
  }
  const symbols: SymbolRecord[] = []
  const edges: EdgeRecord[] = []

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const docs = cleanDocs(leadingJsDoc(text, statement.getFullStart(), statement.getStart(sourceFile)))
      const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
      const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null
      const targetModule = specifier ? resolve(specifier) : null
      for (const element of statement.exportClause.elements) {
        const exportedName = element.name.text
        const localName = element.propertyName?.text ?? exportedName
        const qualifiedName = `${moduleName(module)}.${exportedName}`
        const target = targetModule
          ? `${moduleName(targetModule)}.${localName}`
          : specifier ? null : imports.get(localName) ?? (localDeclarations.has(localName) ? `${moduleName(module)}.${localName}` : null)
        const record: SymbolRecord = {
          qualifiedName,
          name: exportedName,
          kind: "re_export",
          module,
          signature: clip(stripComments(statement.getText(sourceFile)), 12_000),
          docs: clip(docs, 20_000),
          sourcePath: relativePath,
          lineStart: start,
          lineEnd: end,
          source: clip(stripComments(statement.getText(sourceFile)), 2_000),
          isPublic: isModulePublic,
          isDeprecated: /@deprecated\b/i.test(docs),
          isInternal: false,
          category: docs.match(/@category\s+([^\n]+)/i)?.[1]?.trim() ?? null,
          exampleCount: countExamples(docs)
        }
        symbols.push(record)
        if (target && target !== qualifiedName) {
          edges.push({
            fromQualifiedName: qualifiedName,
            toQualifiedName: target,
            type: "re_exports",
            evidence: clip(statement.getText(sourceFile).replace(/\s+/g, " "), 240)
          })
        }
      }
      continue
    }
    const declarations = declarationsFrom(statement)
    for (const declaration of declarations) {
      const localName = declarationName(declaration)
      if (!localName) continue
      const exportedNames = hasExportModifier(statement) ? [localName] : localExports.get(localName) ?? []
      if (exportedNames.length === 0) continue
      const docs = cleanDocs(leadingJsDoc(text, statement.getFullStart(), statement.getStart(sourceFile)))
      const statementText = sourceFragment(declaration, sourceFile)
      const searchableDocs = declarationDocumentation(declaration, docs, sourceFile, relativePath, localDeclarations)
      const signature = declarationSignature(statement, declaration, sourceFile)
      const start = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1
      const end = sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1
      const isInternal = module.startsWith("internal/") || /@internal\b/i.test(docs)
      for (const name of new Set(exportedNames)) {
        const qualifiedName = `${moduleName(module)}.${name}`
        const record: SymbolRecord = {
          qualifiedName,
          name,
          kind: declarationKind(declaration),
          module,
          signature: clip(stripComments(signature), 12_000),
          docs: searchableDocs,
          sourcePath: relativePath,
          lineStart: start,
          lineEnd: end,
          source: clip(statementText, 2_000),
          isPublic: isModulePublic && !isInternal,
          isDeprecated: /@deprecated\b/i.test(docs),
          isInternal,
          category: docs.match(/@category\s+([^\n]+)/i)?.[1]?.trim() ?? null,
          exampleCount: countExamples(docs)
        }
        symbols.push(record)
        edges.push(...extractEdges(record, declaration, sourceFile, imports))
        for (const reference of localTypeReferences(declaration, localDeclarations)) {
          const target = `${moduleName(module)}.${reference.name}`
          if (target !== qualifiedName) edges.push({
            fromQualifiedName: qualifiedName,
            toQualifiedName: target,
            type: "references",
            evidence: clip(reference.node.getText(sourceFile), 240)
          })
        }
        if (name !== localName) {
          edges.push({
            fromQualifiedName: qualifiedName,
            toQualifiedName: `${moduleName(module)}.${localName}`,
            type: "re_exports",
            evidence: `${localName} as ${name}`
          })
        }
      }
    }
  }
  return { symbols, edges }
}

// Exported for tests. Declaration-mode packages (no src/ TypeScript sources)
// index *.d.ts files whose logical modules never match the package.json exports
// map (e.g. exports key "./dist/commonjs/index.js" vs module "commonjs/index"),
// so matching against the exports map would mark every symbol private.
// Declaration files carry no visibility of their own: a module is public unless
// its path contains an "internal" segment. Source-mode behavior is unchanged.
export function moduleIsPublic(module: string, publicModules: Set<string>, mode: "source" | "declaration"): boolean {
  if (mode === "declaration") return !module.split("/").includes("internal")
  return publicModules.size === 0
    ? !module.includes("internal") && !module.includes("/chunks/")
    : publicModules.has(module) || [...publicModules].some((entry) => module === entry || module.startsWith(`${entry}/`))
}

function collectLocalExports(sourceFile: ts.SourceFile): Map<string, string[]> {
  const exports = new Map<string, string[]>()
  const add = (localName: string, exportedName: string): void => {
    const names = exports.get(localName) ?? []
    names.push(exportedName)
    exports.set(localName, names)
  }
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        add(element.propertyName?.text ?? element.name.text, element.name.text)
      }
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      add(statement.expression.text, statement.isExportEquals ? statement.expression.text : "default")
    }
  }
  return exports
}

function logicalModule(file: string, sourceRoot: string, packageRoot: string, packageName: string): string {
  let module = relative(sourceRoot, file).split(sep).join("/")
    .replace(/\.d\.(ts|mts|cts)$/, "")
    .replace(/\.(ts|tsx)$/, "")
  if (sourceRoot === packageRoot) {
    module = module
      .replace(/^dist\/types\//, "")
      .replace(/^dist\//, "")
      .replace(/^types\//, "")
      .replace(/\/index$/, "")
  }
  return module === "" || module === "index" || module === "default"
    ? packageModuleName(packageName)
    : module
}

function packageModuleName(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/[\/-]+/g, "_")
}

type NamedDeclaration = ts.Declaration & { name?: ts.DeclarationName }

function localTypeReferences(node: ts.Node, declarations: Map<string, NamedDeclaration[]>): { name: string; node: ts.Node }[] {
  const references = new Map<string, ts.Node>()
  const isShadowed = (reference: ts.Node, name: string): boolean => {
    // Walk the actual ancestors, even when traversal starts at a declaration's
    // type/heritage subtree. A sibling's generic parameter is not in scope.
    for (let scope: ts.Node | undefined = reference.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
      if ("typeParameters" in scope) {
        const parameters = scope.typeParameters as ts.NodeArray<ts.TypeParameterDeclaration> | undefined
        if (parameters?.some((parameter) => parameter.name.text === name)) return true
      }
      if (ts.isMappedTypeNode(scope) && scope.typeParameter.name.text === name) return true
      if (ts.isConditionalTypeNode(scope) && reference.pos >= scope.trueType.pos && reference.end <= scope.trueType.end) {
        let inferred = false
        const findInference = (candidate: ts.Node): void => {
          if (ts.isInferTypeNode(candidate) && candidate.typeParameter.name.text === name) inferred = true
          // A nested conditional introduces its own inference scope.
          if (!ts.isConditionalTypeNode(candidate)) ts.forEachChild(candidate, findInference)
        }
        findInference(scope.extendsType)
        if (inferred) return true
      }
    }
    return false
  }
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName) && declarations.has(child.typeName.text) && !isShadowed(child, child.typeName.text)) {
      references.set(child.typeName.text, child)
    }
    // Heritage clauses use ExpressionWithTypeArguments rather than TypeReference.
    if (ts.isExpressionWithTypeArguments(child) && ts.isIdentifier(child.expression) && declarations.has(child.expression.text) && !isShadowed(child, child.expression.text)) {
      references.set(child.expression.text, child)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return [...references].map(([name, reference]) => ({ name, node: reference }))
}

/** Propagate only explicit, resolved re-exports, retaining original provenance. */
export function enrichReExports(symbols: SymbolRecord[], edges: EdgeRecord[]): void {
  const originals = new Map(symbols.map((symbol) => [symbol.qualifiedName, { ...symbol }]))
  const targets = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (edge.type !== "re_exports") continue
    const names = targets.get(edge.fromQualifiedName) ?? new Set<string>()
    names.add(edge.toQualifiedName)
    targets.set(edge.fromQualifiedName, names)
  }
  for (const symbol of symbols) {
    if (symbol.kind !== "re_export") continue
    const seen = new Set<string>([symbol.qualifiedName])
    const blocks: string[] = []
    const visit = (name: string, depth: number): void => {
      if (depth > 4 || seen.has(name) || seen.size >= 16) return
      seen.add(name)
      const target = originals.get(name)
      if (!target) return
      const directDocs = target.docs.split(/\n\n\[Referenced type /)[0] ?? ""
      if (directDocs) blocks.push(`[Re-export target ${name}; ${target.sourcePath}:${target.lineStart}-${target.lineEnd}]\n${directDocs}`)
      for (const next of targets.get(name) ?? []) visit(next, depth + 1)
    }
    for (const target of targets.get(symbol.qualifiedName) ?? []) visit(target, 1)
    if (blocks.length === 0) continue
    const extra = clip(blocks.join("\n\n"), 8_000)
    symbol.docs = clip([clip(symbol.docs, 20_000 - extra.length - 4), extra].filter(Boolean).join("\n\n"), 20_000)
  }
}

/** Only API-named headings count as README evidence; incidental mentions do not. */
export function enrichFromReadme(symbols: SymbolRecord[], markdown: string, sourcePath: string): void {
  const names = new Set(symbols.map((symbol) => symbol.name).filter((name) => name !== "default"))
  const lines = markdown.split("\n")
  const headings: { line: number; depth: number; name: string | null }[] = []
  let fence: string | null = null
  for (const [line, text] of lines.entries()) {
    const fenceMatch = text.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch?.[1]) {
      if (!fence) fence = fenceMatch[1][0]!
      else if (fenceMatch[1][0] === fence) fence = null
      continue
    }
    if (fence) continue
    const match = text.match(/^(#{1,6})\s+(.+)/)
    if (!match) continue
    // Case-sensitive identifier boundary: `Parser` cannot claim `parse` docs.
    const firstName = match[2]!.replace(/^[`*]+/, "").match(/^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/)
    const candidate = firstName?.[1]
    headings.push({ line, depth: match[1]!.length, name: candidate && names.has(candidate) ? candidate : null })
  }
  const evidence = new Map<string, string[]>()
  for (const [index, heading] of headings.entries()) {
    if (!heading.name) continue
    const next = headings.slice(index + 1).find((entry) => entry.depth <= heading.depth || (entry.name !== null && entry.name !== heading.name))
    const end = next?.line ?? lines.length
    const excerpts = evidence.get(heading.name) ?? []
    if (excerpts.length >= 2) continue
    excerpts.push(`[README ${sourcePath}:${heading.line + 1}-${end}]\n${clip(lines.slice(heading.line, end).join("\n").trim(), 3_800)}`)
    evidence.set(heading.name, excerpts)
  }
  for (const symbol of symbols) {
    const excerpts = evidence.get(symbol.name)
    if (!excerpts) continue
    const extra = clip(excerpts.join("\n\n"), 4_000)
    symbol.docs = clip(`${clip(symbol.docs, 20_000 - extra.length - 4)}\n\n${extra}`.trim(), 20_000)
  }
}

/** Preserve member documentation without treating member tags as tags on the owner.
 * Local type expansion is bounded and follows only the declared surface, never
 * arbitrary identifiers, external types, implementation bodies, or member chains.
 */
function declarationDocumentation(
  declaration: NamedDeclaration,
  ownDocs: string,
  sourceFile: ts.SourceFile,
  sourcePath: string,
  declarations: Map<string, NamedDeclaration[]>
): string {
  const blocks: string[] = []
  const seen = new Set<ts.Node>()
  const location = (node: ts.Node): string => `${sourcePath}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`
  const members = (node: ts.Node): void => {
    // Only declaration/type surfaces: do not collect comments in method bodies.
    const children = ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)
      ? [...node.members]
      : ts.isTypeAliasDeclaration(node) ? [node.type]
      : ts.isVariableDeclaration(node) && node.type ? [node.type]
      : ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node) ? [...node.types]
      : []
    for (const child of children) {
      const docs = cleanDocs(leadingJsDoc(sourceFile.text, child.getFullStart(), child.getStart(sourceFile)))
      if (docs) {
        const name = "name" in child && child.name && typeof child.name === "object" && "getText" in child.name
          ? (child.name as ts.Node).getText(sourceFile)
          : ts.SyntaxKind[child.kind]
        blocks.push(`[Member ${name}; ${location(child)}]\n${docs}`)
      }
      if (ts.isTypeLiteralNode(child) || ts.isIntersectionTypeNode(child) || ts.isUnionTypeNode(child)) members(child)
      else if (ts.isPropertySignature(child) && child.type && ts.isTypeLiteralNode(child.type)) members(child.type)
    }
  }
  const expand = (node: NamedDeclaration, depth: number): void => {
    if (seen.has(node) || seen.size >= 16 || depth > 2) return
    seen.add(node)
    if (node !== declaration) {
      const parent = ts.isVariableDeclaration(node) ? node.parent.parent : node
      const docs = cleanDocs(leadingJsDoc(sourceFile.text, parent.getFullStart(), parent.getStart(sourceFile)))
      blocks.push(`[Referenced type ${declarationName(node)}; ${location(node)}]\n${docs}\n${clip(stripComments(declarationSignature(parent as ts.Statement, node, sourceFile)), 1_600)}`)
    }
    members(node)
    const surfaces: ts.Node[] = ts.isVariableDeclaration(node) && node.type ? [node.type]
      : ts.isTypeAliasDeclaration(node) ? [node.type]
      : ts.isClassDeclaration(node) ? [...(node.heritageClauses ?? []), ...node.members.filter(ts.isConstructorDeclaration).flatMap(c => c.parameters.flatMap(p => p.type ? [p.type] : []))]
      : ts.isInterfaceDeclaration(node) ? [...(node.heritageClauses ?? [])]
      : []
    for (const surface of surfaces) {
      for (const reference of localTypeReferences(surface, declarations)) {
        for (const target of declarations.get(reference.name) ?? []) expand(target, depth + 1)
      }
    }
  }
  expand(declaration, 0)
  if (blocks.length === 0) return clip(ownDocs, 20_000)
  // Give every documented member a fair share so large classes retain late
  // members too. Existing per-record bounds still apply across all formats.
  const primary = clip(ownDocs, 6_000)
  const allowance = Math.max(80, Math.floor((20_000 - primary.length - blocks.length * 2) / blocks.length) - 2)
  return clip([primary, ...blocks.map((block) => clip(block, allowance))].filter(Boolean).join("\n\n"), 20_000)
}

function declarationsFrom(statement: ts.Statement): NamedDeclaration[] {
  if (ts.isVariableStatement(statement)) return [...statement.declarationList.declarations]
  if (
    ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)
  ) return [statement]
  return []
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

function declarationName(node: NamedDeclaration): string | null {
  const name = node.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function declarationKind(node: NamedDeclaration): string {
  if (ts.isVariableDeclaration(node)) return "const"
  if (ts.isFunctionDeclaration(node)) return "function"
  if (ts.isClassDeclaration(node)) return "class"
  if (ts.isInterfaceDeclaration(node)) return "interface"
  if (ts.isTypeAliasDeclaration(node)) return "type"
  if (ts.isEnumDeclaration(node)) return "enum"
  if (ts.isModuleDeclaration(node)) return "namespace"
  return "symbol"
}

function declarationSignature(statement: ts.Statement, declaration: NamedDeclaration, sourceFile: ts.SourceFile): string {
  if (ts.isVariableDeclaration(declaration)) {
    const name = declaration.name.getText(sourceFile)
    const type = declaration.type ? `: ${declaration.type.getText(sourceFile)}` : ""
    return `export const ${name}${type}`
  }
  if (ts.isFunctionDeclaration(declaration) && declaration.body) {
    return declaration.getText(sourceFile).slice(0, declaration.body.getStart(sourceFile)).trim()
  }
  return statement.getText(sourceFile)
}

function sourceFragment(declaration: NamedDeclaration, sourceFile: ts.SourceFile): string {
  if (ts.isVariableDeclaration(declaration)) {
    const initializer = declaration.initializer?.getText(sourceFile) ?? ""
    return `${declaration.name.getText(sourceFile)}${initializer ? ` = ${initializer}` : ""}`
  }
  return stripComments(declaration.getText(sourceFile))
}

function collectImports(sourceFile: ts.SourceFile, resolve: (specifier: string) => string | null): Map<string, string> {
  const imports = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const resolved = resolve(statement.moduleSpecifier.text)
    if (resolved === null) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) imports.set(clause.name.text, `${moduleName(resolved)}.default`)
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, moduleName(resolved))
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        imports.set(element.name.text, `${moduleName(resolved)}.${element.propertyName?.text ?? element.name.text}`)
      }
    }
  }
  return imports
}

function resolveFileModule(file: string, specifier: string, sourceRoot: string, packageRoot: string, packageName: string, mode: "source" | "declaration"): string | null {
  if (!specifier.startsWith(".")) return specifier
  // Resolve from the physical importer, then apply the same canonical module
  // mapping used for indexed symbols. Collapsed index modules are not folders.
  const path = join(dirname(file), specifier)
  const base = path.replace(/(?:\.d)?\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/, "")
  const extensions = mode === "declaration"
    ? [".d.ts", ".d.mts", ".d.cts", ".ts", ".tsx"]
    : [".ts", ".tsx", ".d.ts", ".d.mts", ".d.cts"]
  const candidates = [...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => join(base, `index${extension}`))]
  for (const candidate of candidates) {
    if (relative(packageRoot, candidate).startsWith(`..${sep}`)) continue
    try {
      if (statSync(candidate).isFile()) return logicalModule(candidate, sourceRoot, packageRoot, packageName)
    } catch { /* Missing sibling: try the next supported source extension. */ }
  }
  return null
}

function extractEdges(
  symbol: SymbolRecord,
  declaration: NamedDeclaration,
  sourceFile: ts.SourceFile,
  imports: Map<string, string>
): EdgeRecord[] {
  const edges = new Map<string, EdgeRecord>()
  const add = (target: string, type: EdgeRecord["type"], evidence: string): void => {
    if (target === symbol.qualifiedName) return
    edges.set(`${type}:${target}`, {
      fromQualifiedName: symbol.qualifiedName,
      toQualifiedName: target,
      type,
      evidence: clip(evidence.replace(/\s+/g, " "), 240)
    })
  }
  const text = declaration.getText(sourceFile)
  for (const [alias, targetModule] of imports) {
    const namespacePattern = new RegExp(`\\b${escapeRegExp(alias)}\\.([A-Za-z_$][\\w$]*)`, "g")
    for (const match of text.matchAll(namespacePattern)) {
      add(`${targetModule}.${match[1]}`, "references", match[0])
    }
    if (targetModule.includes(".") && new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(text)) {
      add(targetModule, "references", alias)
    }
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = declaration.initializer.getText(sourceFile)
    for (const [alias, targetModule] of imports) {
      const match = initializer.match(new RegExp(`^${escapeRegExp(alias)}\\.([A-Za-z_$][\\w$]*)`))
      if (match?.[1]) add(`${targetModule}.${match[1]}`, "delegates_to", initializer)
    }
  }
  for (const match of symbol.docs.matchAll(/\{@link\s+([A-Za-z_$][\w$.]*)/g)) {
    const raw = match[1]
    if (!raw) continue
    const imported = imports.get(raw)
    const target = imported
      ? imported.includes(".") ? imported : `${imported}.${basename(imported)}`
      : raw.includes(".") ? raw : `${moduleName(symbol.module)}.${raw}`
    add(target, "references", `@link ${raw}`)
  }
  return [...edges.values()]
}

function moduleName(module: string): string {
  return module.split("/").filter(Boolean).map((part) => part.replace(/[^A-Za-z0-9_$]/g, "_")).join("/") || "index"
}

function leadingJsDoc(text: string, fullStart: number, start: number): string {
  const leading = text.slice(fullStart, start)
  const matches = [...leading.matchAll(/\/\*\*[\s\S]*?\*\//g)]
  return matches.at(-1)?.[0] ?? ""
}

function cleanDocs(value: string): string {
  return value
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim()
}

function countExamples(docs: string): number {
  return (docs.match(/\*\*Example\*\*|@example\b/gi) ?? []).length
}

function splitIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n…`
}

function stripComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\n{3,}/g, "\n\n").trim()
}

function mergeSymbols(symbols: SymbolRecord[]): SymbolRecord[] {
  const merged = new Map<string, SymbolRecord>()
  for (const symbol of symbols) {
    const current = merged.get(symbol.qualifiedName)
    if (!current) {
      merged.set(symbol.qualifiedName, symbol)
      continue
    }
    merged.set(symbol.qualifiedName, {
      ...current,
      kind: preferredKind(current.kind, symbol.kind),
      signature: mergeText(current.signature, symbol.signature, 12_000),
      docs: mergeText(current.docs, symbol.docs, 20_000),
      source: mergeText(current.source, symbol.source, 2_000),
      lineStart: Math.min(current.lineStart, symbol.lineStart),
      lineEnd: Math.max(current.lineEnd, symbol.lineEnd),
      isPublic: current.isPublic || symbol.isPublic,
      isDeprecated: current.isDeprecated && symbol.isDeprecated,
      isInternal: current.isInternal && symbol.isInternal,
      category: current.category ?? symbol.category,
      exampleCount: current.exampleCount + symbol.exampleCount
    })
  }
  return [...merged.values()]
}

function mergeText(left: string, right: string, max: number): string {
  if (!right || left === right || left.includes(right)) return clip(left, max)
  if (!left || right.includes(left)) return clip(right, max)
  return clip(`${left}\n\n${right}`, max)
}

function preferredKind(left: string, right: string): string {
  const order = ["const", "function", "class", "interface", "type", "enum", "namespace", "symbol"]
  return order.indexOf(left) <= order.indexOf(right) ? left : right
}

function uniqueEdgeCount(edges: EdgeRecord[]): number {
  return new Set(edges.map((edge) => `${edge.fromQualifiedName}\0${edge.toQualifiedName}\0${edge.type}`)).size
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
