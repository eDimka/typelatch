import { createRequire } from "node:module"
import { dirname, extname, resolve } from "node:path"
import type { WorkspaceFile } from "./inventory.js"

const require = createRequire(import.meta.url)
const BYTE_LIMIT = 24 * 1024
const FILE_BYTE_LIMIT = 8 * 1024
const FILE_LIMIT = 12
type Hit = { origin: "workspace" | "dependency"; source: string; line: number; snippet?: string; position?: number | null }
type Selection = { file: WorkspaceFile; hit: Pick<Hit, "line" | "snippet" | "position">; reason: "result" | "relative-import" }

function imports(file: WorkspaceFile): string[] {
  if (!/\.[cm]?[jt]sx?$/.test(file.path)) return []
  const ts = require("typescript") as typeof import("typescript")
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false)
  return source.statements.flatMap(statement => {
    const specifier = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier
      : ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) ? statement.moduleReference.expression : undefined
    return specifier && ts.isStringLiteral(specifier) && /^\.\.?\//.test(specifier.text) ? [specifier.text] : []
  })
}

// These are source candidates only. Compiler settings and package resolution are not evaluated.
function candidates(source: string, specifier: string): string[] {
  const target = resolve(dirname(source), specifier)
  const extension = extname(target)
  const replacements: Record<string, string[]> = {
    ".js": [".ts", ".tsx", ".d.ts", ".js", ".jsx"], ".jsx": [".tsx", ".ts", ".d.ts", ".jsx", ".js"],
    ".mjs": [".mts", ".d.mts", ".mjs"], ".cjs": [".cts", ".d.cts", ".cjs"]
  }
  if (replacements[extension]) return replacements[extension].map(suffix => target.slice(0, -extension.length) + suffix)
  if (extension) return [target]
  const suffixes = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]
  return [target, ...suffixes.map(suffix => target + suffix), ...suffixes.map(suffix => resolve(target, "index" + suffix))]
}

function excerpt(file: WorkspaceFile, hit: Selection["hit"], budget: number) {
  const data = Buffer.from(file.text)
  const total = data.length
  let start = 0
  if (total > budget) {
    let offset = 0
    for (let line = 1; line < hit.line; line++) {
      const end = file.text.indexOf("\n", offset)
      if (end === -1) break
      offset = end + 1
    }
    const snippetOffset = hit.snippet ? file.text.indexOf(hit.snippet, offset) : -1
    let anchor = hit.position ?? (snippetOffset >= offset ? snippetOffset : offset)
    if (anchor > 0 && /[\uDC00-\uDFFF]/.test(file.text[anchor] ?? "")) anchor--
    const anchorByte = Buffer.byteLength(file.text.slice(0, anchor))
    // Reserve most of the budget for the selected hit, even after a generated long line.
    start = Math.max(0, anchorByte - Math.floor(budget / 4))
    while (start < data.length && (data[start]! & 0xc0) === 0x80) start++
    const newline = data.indexOf(10, start)
    if (newline >= start && newline < anchorByte) start = newline + 1
  }
  let end = Math.min(total, start + budget)
  // A byte budget must not split a UTF8 code point.
  while (end < data.length && end > 0 && (data[end]! & 0xc0) === 0x80) end--
  const text = data.subarray(start, end).toString("utf8")
  const before = data.subarray(0, start).toString("utf8")
  const startLine = 1 + (before.match(/\n/g)?.length ?? 0)
  const startColumn = before.length - before.lastIndexOf("\n")
  return {
    source: file.path, sha256: file.hash, text, startLine, startColumn,
    endLine: startLine + (text.replace(/\n$/, "").match(/\n/g)?.length ?? 0),
    bytes: end - start, complete: start === 0 && end === total, omittedBytes: total - (end - start),
    omittedBefore: start, omittedAfter: total - end
  }
}

export function sourceContext(files: WorkspaceFile[], hits: Hit[], signal: AbortSignal) {
  const available = new Map(files.filter(file => file.searchable).map(file => [file.path, file]))
  const selected = new Map<string, Selection>()
  for (const hit of hits) {
    const file = hit.origin === "workspace" ? available.get(hit.source) : undefined
    if (file && !selected.has(file.path)) selected.set(file.path, { file, hit, reason: "result" })
  }
  let unavailableImports = 0
  let ambiguousImports = 0
  // Follow one hop from selected results, never from newly discovered imports.
  for (const { file } of [...selected.values()]) {
    signal.throwIfAborted()
    for (const specifier of new Set(imports(file))) {
      const matches = candidates(file.path, specifier).flatMap(path => available.has(path) ? [available.get(path)!] : [])
      if (matches.length !== 1) { unavailableImports++; if (matches.length > 1) ambiguousImports++; continue }
      const imported = matches[0]!
      if (!selected.has(imported.path)) selected.set(imported.path, { file: imported, hit: { line: 1 }, reason: "relative-import" })
    }
  }
  let bytes = 0
  const output = []
  for (const { file, hit, reason } of selected.values()) {
    signal.throwIfAborted()
    if (output.length >= FILE_LIMIT || bytes >= BYTE_LIMIT) break
    const item = { ...excerpt(file, hit, Math.min(FILE_BYTE_LIMIT, BYTE_LIMIT - bytes)), reason }
    output.push(item)
    bytes += item.bytes
  }
  return {
    files: output, bytes, byteLimit: BYTE_LIMIT, fileByteLimit: FILE_BYTE_LIMIT, fileLimit: FILE_LIMIT,
    filesOmitted: selected.size - output.length, unavailableImports, ambiguousImports, resolution: "not-run" as const
  }
}
