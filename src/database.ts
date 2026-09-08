import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import type { BrainFormat } from "./types.js"

export function createBrainDatabase(path: string, format: BrainFormat = "compact"): Database.Database {
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.exec(format === "baseline" ? baselineSchema : format === "trimmed" ? trimmedSchema : compactSchema)
  return db
}

const sharedPrefix = `
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`

const sharedSearch = `
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_search USING fts5(
      title,
      body,
      tags,
      content = '',
      tokenize = 'porter unicode61'
    );`

const baselineSchema = `
    ${sharedPrefix}
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY,
      qualified_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      module TEXT NOT NULL,
      signature TEXT NOT NULL,
      docs TEXT NOT NULL,
      source_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      source TEXT NOT NULL,
      is_public INTEGER NOT NULL,
      is_deprecated INTEGER NOT NULL,
      is_internal INTEGER NOT NULL,
      category TEXT,
      example_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS symbols_module ON symbols(module);
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY,
      from_symbol TEXT NOT NULL,
      to_symbol TEXT NOT NULL,
      type TEXT NOT NULL,
      evidence TEXT NOT NULL,
      UNIQUE(from_symbol, to_symbol, type)
    );
    CREATE INDEX IF NOT EXISTS edges_from ON edges(from_symbol);
    CREATE INDEX IF NOT EXISTS edges_to ON edges(to_symbol);
    ${sharedSearch}
  `

const compactSchema = `
    ${sharedPrefix}
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY,
      qualified_name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY REFERENCES nodes(id),
      qualified_name TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      module TEXT NOT NULL,
      signature TEXT NOT NULL,
      docs TEXT NOT NULL,
      source_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      source TEXT NOT NULL,
      is_public INTEGER NOT NULL,
      is_deprecated INTEGER NOT NULL,
      is_internal INTEGER NOT NULL,
      category TEXT,
      example_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS symbols_module ON symbols(module);
    CREATE TABLE IF NOT EXISTS edges (
      from_id INTEGER NOT NULL REFERENCES nodes(id),
      type INTEGER NOT NULL,
      to_id INTEGER NOT NULL REFERENCES nodes(id),
      evidence TEXT NOT NULL,
      PRIMARY KEY(from_id, type, to_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id, type, from_id);
    ${sharedSearch}
  `

const trimmedSchema = `
    ${sharedPrefix}
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY,
      qualified_name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY REFERENCES nodes(id),
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      module TEXT NOT NULL,
      signature TEXT NOT NULL,
      docs TEXT NOT NULL,
      source_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      is_public INTEGER NOT NULL,
      is_deprecated INTEGER NOT NULL,
      is_internal INTEGER NOT NULL,
      category TEXT,
      example_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS edges (
      from_id INTEGER NOT NULL REFERENCES nodes(id),
      type INTEGER NOT NULL,
      to_id INTEGER NOT NULL REFERENCES nodes(id),
      PRIMARY KEY(from_id, type, to_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id, type, from_id);
    ${sharedSearch}
  `

export function openBrainDatabase(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true })
}

const emptyFloorCache = new Map<BrainFormat, number>()

/**
 * On-disk size of a freshly created, completely empty brain of the given
 * format (schema, empty FTS index, and page allocation only). Column-level
 * shrink levers cannot go below this floor, so size gates for small brains
 * measure reduction against the bytes above it.
 */
export function emptyBrainFloor(format: BrainFormat): number {
  const cached = emptyFloorCache.get(format)
  if (cached !== undefined) return cached
  const directory = mkdtempSync(join(tmpdir(), "typelatch-floor-"))
  const path = join(directory, "empty.db")
  try {
    const db = createBrainDatabase(path, format)
    db.pragma("journal_mode = DELETE")
    db.exec("VACUUM")
    db.close()
    const bytes = statSync(path).size
    emptyFloorCache.set(format, bytes)
    return bytes
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
