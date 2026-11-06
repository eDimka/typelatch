import { z } from "zod"
export const searchSchema = z.object({
  workspaceRoot: z.string().min(1),
  question: z.string().trim().min(1).max(2000),
  file: z.string().min(1).optional(),
  scope: z.enum(["all", "workspace", "dependencies"]).optional(),
  detail: z.enum(["full", "compact", "source"]).optional().describe("Compact preserves coverage and checks with 360 character previews. Source adds deduplicated workspace text and direct relative import candidates, capped at 24 KiB total, 8 KiB per file and 12 files, with hashes and explicit omissions. Compiler resolution is not run"),
  limit: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional()
}).strict()
const overlays = z.array(z.object({ file: z.string().min(1), text: z.string().max(1_000_000) }).strict()).max(50).optional()
export const contextSchema = z.object({
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  config: z.string().min(1).describe("Path to the owning tsconfig or a solution that references it. Prefer an absolute path"),
  file: z.string().min(1).describe("Source file path, absolute or relative to the selected config directory"),
  symbol: z.string().min(1).max(300).optional().describe("Exact exported name or namespace path within importSpecifier, such as Schema.Struct. Omit question for installed API evidence without a package index"),
  position: z.number().int().nonnegative().optional().describe("Zero based UTF16 offset in the source file for live hover, definitions and references"),
  importSpecifier: z.string().min(1).optional().describe("Import path resolved by the project compiler. An absent import uses a temporary in memory probe without editing the file"),
  question: z.string().min(1).optional().describe("Discovery question for an existing exact version package index after import resolution. Omit for installed API evidence alone"),
  expectedVersion: z.string().min(1).optional().describe("Expected installed package version. Inspect versionMatch: a mismatch fails that check while actual installed API evidence can remain returned"), overlays,
  limit: z.number().int().min(1).max(20).optional()
}).strict()
export const validationSchema = z.object({
  config: z.string().min(1), overlays,
  testCommand: z.array(z.string()).min(1).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  workspaceRoot: z.string().min(1).optional(),
  runtimeInputs: z.array(z.string().min(1)).max(100).optional(),
  snapshotExclude: z.array(z.string().min(1)).max(100).optional(),
  queryId: z.string().uuid().optional(), record: z.boolean().optional()
}).strict()
