import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { brainHome } from "../paths.js"
import { hash, type WorkspaceFile } from "./inventory.js"

export type SearchChunk = { source: string; line: number; endLine: number; symbol: string | null; position: number | null; snippet: string }
type IndexedChunk = SearchChunk & { offset: number; length: number }
type StoredChunk = Omit<SearchChunk, "snippet"> & { offset: number; length: number }
const stop = new Set("a an and are as at be before by can do does find for from how i in is it its locate me my of on or our should show that the their this to use we what when where which with within would".split(" "))
const words = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []
const stem = (value: string) => value.length < 5 ? value : value.replace(/(?:ing|ions?|ed|es|s)$/, "").replace(/e$/, "")
export const queryTerms = (question: string) => [...new Set(words(question).filter(word => !stop.has(word)).map(stem))].slice(0, 16)

/** A shared lexical score, independent of each package's rank and corpus size. */
export function scoreCandidate(question: string, title: string, body: string): { score: number; matchedTerms: string[] } {
  if (/^[\w$.]+$/.test(question.trim()) && /[a-z][A-Z]|[._$]/.test(question) && !`${title}\n${body}`.toLowerCase().includes(question.trim().toLowerCase())) return { score: 0, matchedTerms: [] }
  const terms = queryTerms(question)
  const titleWords = new Set(words(title).map(stem))
  const bodyWords = new Set(words(body).map(stem))
  const matchedTerms = terms.filter(term => titleWords.has(term) || bodyWords.has(term))
  if (!matchedTerms.length) return { score: 0, matchedTerms }
  const names = title.split(/\s+/).flatMap(name => [name, name.split(".").at(-1)!])
  const exact = names.some(name => name.toLowerCase() === question.trim().toLowerCase())
  const exactCase = names.includes(question.trim())
  return { score: (exact ? 1000 : 0) + (exactCase ? 50 : 0) + Math.round(100 * matchedTerms.length / terms.length) + terms.filter(term => titleWords.has(term)).length * 12, matchedTerms }
}

export function searchWorkspaceIndex(root: string, files: WorkspaceFile[], question: string, signal: AbortSignal) {
  const directory = join(brainHome(), "workspaces", hash(root))
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "search.db")
  const db = new Database(path)
  db.pragma("busy_timeout = 5000")
  db.pragma("journal_mode = WAL")
  const schemaVersion = 6
  let updatedFiles = 0
  let removedFiles = 0
  const truncated: string[] = []
  try {
    db.exec("BEGIN IMMEDIATE")
    const previousVersion = db.pragma("user_version", { simple: true })
    if (previousVersion !== schemaVersion) {
      db.exec("DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS chunk_content; DROP TABLE IF EXISTS files")
      db.exec(`CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, truncated INTEGER NOT NULL);
        CREATE TABLE chunk_content(id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, line INTEGER NOT NULL, endLine INTEGER NOT NULL, symbol TEXT NOT NULL, position INTEGER, offset INTEGER NOT NULL, length INTEGER NOT NULL);
        CREATE INDEX chunk_content_file ON chunk_content(file_id);
        CREATE VIRTUAL TABLE chunks USING fts5(symbol, snippet, terms, content='', contentless_delete=1, tokenize='porter unicode61');
        PRAGMA user_version = ${schemaVersion}`)
    }
    const stored = new Map((db.prepare("SELECT id, path, hash, truncated FROM files").all() as Array<{ id: number; path: string; hash: string; truncated: number }>).map(item => [item.path, item]))
    const removeSearch = db.prepare("DELETE FROM chunks WHERE rowid IN (SELECT id FROM chunk_content WHERE file_id = ?)")
    const removeContent = db.prepare("DELETE FROM chunk_content WHERE file_id = ?")
    const remove = (id: number) => { removeSearch.run(id); removeContent.run(id) }
    const insert = db.prepare("INSERT INTO chunk_content(file_id,line,endLine,symbol,position,offset,length) VALUES (?,?,?,?,?,?,?)")
    const insertSearch = db.prepare("INSERT INTO chunks(rowid,symbol,snippet,terms) VALUES (?,?,?,?)")
    const save = db.prepare("INSERT INTO files(path,hash,truncated) VALUES (?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, truncated=excluded.truncated RETURNING id")
    db.transaction(() => {
      for (const file of files.filter(file => file.searchable)) {
        signal.throwIfAborted()
        const prior = stored.get(file.path)
        stored.delete(file.path)
        const inputHash = hash(`${ts.version}:${file.hash}`)
        if (prior?.hash === inputHash) { if (prior.truncated) truncated.push(file.path); continue }
        const chunks = chunksForFile(file)
        const limited = chunks.length > 500
        if (limited) truncated.push(file.path)
        const saved = save.get(file.path, inputHash, limited ? 1 : 0) as { id: number }
        remove(saved.id)
        for (const chunk of chunks.slice(0, 500)) {
          const row = insert.run(saved.id, chunk.line, chunk.endLine, chunk.symbol ?? "", chunk.position, chunk.offset, chunk.length)
          // The current inventory already holds the exact hash-validated source text.
          insertSearch.run(row.lastInsertRowid, chunk.symbol ?? "", chunk.snippet, words(`${relative(root, file.path)} ${chunk.symbol ?? ""} ${chunk.snippet}`).join(" "))
        }
        updatedFiles++
      }
      for (const [path, prior] of stored) {
        remove(prior.id)
        db.prepare("DELETE FROM files WHERE path = ?").run(path)
        removedFiles++
      }
    })()
    const terms = queryTerms(question)
    const match = terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(" OR ")
    const rows = match ? db.prepare(`SELECT files.path AS source, content.line, content.endLine, content.symbol, content.position, content.offset, content.length
      FROM chunks JOIN chunk_content AS content ON content.id = chunks.rowid JOIN files ON files.id = content.file_id
      WHERE chunks MATCH ? ORDER BY bm25(chunks,6,1,1), source, line LIMIT 401`).all(match) as StoredChunk[] : []
    const textByPath = new Map(files.map(file => [file.path, file.text]))
    const candidates: SearchChunk[] = rows.slice(0, 400).map(({ offset, length, ...row }) => {
      const text = textByPath.get(row.source)
      if (text === undefined) throw new Error("Workspace cache references a file outside the current inventory")
      return { ...row, symbol: row.symbol || null, line: Number(row.line), endLine: Number(row.endLine), position: row.position === null ? null : Number(row.position), snippet: text.slice(offset, offset + length) }
    })
    db.exec("COMMIT")
    // Initial FTS builds and schema replacements can leave freed pages allocated.
    if (previousVersion !== schemaVersion) db.exec("VACUUM")
    return {
      candidates,
      index: { path, updatedFiles, removedFiles, files: files.filter(file => file.searchable).length, snapshot: hash(JSON.stringify(files.map(file => [file.path, file.hash]))) },
      truncated, candidateLimitReached: rows.length > 400
    }
  } finally { if (db.inTransaction) db.exec("ROLLBACK"); db.close() }
}

function chunksForFile(file: WorkspaceFile): IndexedChunk[] {
  const lines = file.text.split("\n")
  let offset = 0
  const lineOffsets = lines.map(line => { const start = offset; offset += line.length + 1; return start })
  const chunks: IndexedChunk[] = []
  const add = (line: number, endLine: number, symbol: string | null = null, position: number | null = null) => {
    const text = lines.slice(line - 1, endLine).join("\n")
    // Long generated lines are split, never silently discarded from the index.
    for (let offset = 0; offset < text.length; offset += 2000) {
      const snippet = text.slice(offset, offset + 2400)
      const start = line + (text.slice(0, offset).match(/\n/g)?.length ?? 0)
      const nameOffset = position === null ? null : position - lineOffsets[line - 1]!
      const containsName = nameOffset !== null && nameOffset >= offset && nameOffset < offset + snippet.length
      chunks.push({ source: file.path, line: start, endLine: start + (snippet.match(/\n/g)?.length ?? 0), symbol: containsName ? symbol : null, position: containsName ? position : null, snippet, offset: lineOffsets[line - 1]! + offset, length: snippet.length })
    }
  }
  if (/\.(?:[cm]?[jt]sx?)$/.test(file.path)) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (chunks.length > 500) return
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
        const position = node.name.getStart(source)
        const line = source.getLineAndCharacterOfPosition(position).line + 1
        add(line, Math.min(lines.length, line + 11), node.name.text, position)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  for (let start = 0; start < lines.length && chunks.length <= 500; start += 12) add(start + 1, Math.min(start + 16, lines.length))
  return chunks
}
