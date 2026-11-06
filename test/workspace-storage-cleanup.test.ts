import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hash, type WorkspaceFile } from "../src/workspace/inventory.js"
import { searchWorkspaceIndex } from "../src/workspace/search-index.js"

describe("workspace cache connection cleanup", () => {
  let directory: string
  let root: string
  let previousHome: string | undefined
  const handles = new Set<Database.Database>()
  const search = () => {
    const text = "export const cleanupMarker = true\n"
    const files: WorkspaceFile[] = [{ path: join(root, "source.ts"), text, hash: hash(text), searchable: true }]
    return searchWorkspaceIndex(root, files, "cleanupMarker", new AbortController().signal)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "typelatch-storage-cleanup-"))
    root = join(directory, "workspace")
    previousHome = process.env.TYPELATCH_HOME
    process.env.TYPELATCH_HOME = join(directory, "data")
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of handles) if (db.open) db.close()
    handles.clear()
    if (previousHome === undefined) delete process.env.TYPELATCH_HOME
    else process.env.TYPELATCH_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(["page_count", "journal_mode = WAL"])("closes the real connection when setup pragma %s fails", failingPragma => {
    const pragma = Database.prototype.pragma
    const failure = new Error("injected setup failure")
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      handles.add(this)
      if (source === failingPragma) throw failure
      return pragma.call(this, source, options)
    })

    expect(search).toThrow(failure)
    expect(handles.size).toBe(1)
    for (const db of handles) expect(db.open).toBe(false)
  })

  it("closes the real connection even when an active transaction rollback fails", () => {
    const pragma = Database.prototype.pragma
    const exec = Database.prototype.exec
    const rollbackFailure = new Error("injected rollback failure")
    let rollbackHadActiveTransaction = false
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      handles.add(this)
      if (source === "user_version") throw new Error("injected schema inspection failure")
      return pragma.call(this, source, options)
    })
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql) {
      if (sql === "ROLLBACK") {
        rollbackHadActiveTransaction = this.inTransaction
        throw rollbackFailure
      }
      return exec.call(this, sql)
    })

    expect(search).toThrow(rollbackFailure)
    expect(rollbackHadActiveTransaction).toBe(true)
    expect(handles.size).toBe(1)
    for (const db of handles) expect(db.open).toBe(false)
  })
})
